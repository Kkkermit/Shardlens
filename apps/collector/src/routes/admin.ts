import { MAX_EVENT_WEIGHT, Snowflake } from '@shardlens/schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isDiscordWebhookUrl, maskStoredWebhook, postToDiscordWebhook } from '../discord-webhook.js';
import { dashboardUrl } from '../env.js';
import { UNREADABLE_WEBHOOK } from '../jobs/alerts.js';
import { TimeZoneName } from '../query/spec.js';
import { auditCipher } from '../security/crypto.js';
import { newApiKey } from '../security/keys.js';
import type { Deps } from '../server.js';
import { adminAudit, requireAdmin } from './guard.js';

const BADGES = ['servers', 'users-monthly', 'commands-daily'] as const;

/** A kept event carries the weight 1 / rate, and the wire refuses weights over `MAX_EVENT_WEIGHT`. */
const SampleRate = z
  .number()
  .min(1 / MAX_EVENT_WEIGHT)
  .max(1);

export const SettingsPatch = z
  .object({
    // Not `TimeZone.optional()`: its default would reset the zone to UTC on every save that leaves it out.
    timezone: TimeZoneName.optional(),
    rawRetentionDays: z.number().int().min(7).max(90).optional(),
    /** Hard maximum 90 days: larger values are rejected, not clamped. */
    auditRetentionDays: z.number().int().min(1).max(90).optional(),
    mode: z.enum(['privacy', 'audit']).optional(),
    saltPeriod: z.enum(['day', 'week', 'month']).optional(),
    // The Servers filter compares it with each server's bits as a PostgreSQL bigint.
    requiredPermissions: z
      .string()
      .regex(/^\d{1,19}$/)
      .refine((bits) => BigInt(bits) < 2n ** 63n, 'over 63 bits')
      .nullable()
      .optional(),
    skuPrices: z
      .record(
        Snowflake,
        z.object({ amount: z.number().nonnegative().max(1_000_000), currency: z.string().regex(/^[A-Z]{3}$/) }),
      )
      .optional(),
    sampling: z.record(z.string().max(32), SampleRate).optional(),
    badges: z.array(z.enum(BADGES)).max(BADGES.length).optional(),
  })
  .strict();

export const ALERT_METRICS = [
  'missed_deadline_rate',
  'error_rate',
  'p95_ms',
  'invalid_requests_pct',
  'stale_shards',
  'interactions_per_min',
  'identify_remaining',
] as const;

export const AlertBody = z
  .object({
    name: z.string().min(1).max(100),
    metric: z.enum(ALERT_METRICS),
    comparator: z.enum(['>', '>=', '<', '<=']),
    threshold: z.number().finite(),
    windowS: z.number().int().min(60).max(86_400),
    webhookUrl: z
      .string()
      .max(300)
      .refine(isDiscordWebhookUrl, 'must be a Discord webhook URL (https://discord.com/api/webhooks/…)'),
  })
  .strict();

/** The path parameter of a key, an alert or a report. */
export const IdParam = z.object({ id: z.string().regex(/^\d{1,18}$/) });

/** Turns an alert or a report on or off. */
export const EnabledBody = z.object({ enabled: z.boolean() }).strict();

const SETTING_KEYS: Record<string, string> = {
  auditRetentionDays: 'audit_retention_days',
  requiredPermissions: 'required_permissions',
  skuPrices: 'sku_prices',
  sampling: 'sampling',
  badges: 'badges',
};

async function readSettings(deps: Deps, appId: string) {
  const app = await deps.db.query<{
    timezone: string;
    raw_retention_days: number;
    mode: string;
    salt_period: string;
  }>('SELECT timezone, raw_retention_days, mode, salt_period FROM apps WHERE app_id = $1', [appId]);
  const rows = await deps.db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM settings WHERE app_id = $1',
    [appId],
  );
  const s = Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
  const a = app.rows[0];
  return {
    timezone: a?.timezone ?? 'UTC',
    rawRetentionDays: a?.raw_retention_days ?? 35,
    auditRetentionDays: (s.audit_retention_days as number | undefined) ?? 30,
    mode: a?.mode ?? 'privacy',
    saltPeriod: a?.salt_period ?? 'month',
    requiredPermissions: (s.required_permissions as string | undefined) ?? null,
    skuPrices: (s.sku_prices as Record<string, { amount: number; currency: string }> | undefined) ?? {},
    sampling: (s.sampling as Record<string, number> | undefined) ?? {},
    badges: (s.badges as string[] | undefined) ?? [],
    auditKeyConfigured: deps.config.auditKey !== undefined,
    modeSetByEnvironment: deps.config.mode !== undefined,
  };
}

export async function adminRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const settingsCipher = auditCipher(deps.config.settingsKey);

  app.get('/v1/settings', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply);
    if (!admin) return;
    return readSettings(deps, admin.appId);
  });

  app.put('/v1/settings', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const patch = SettingsPatch.parse(req.body ?? {});
    if (patch.mode !== undefined && deps.config.mode !== undefined && patch.mode !== deps.config.mode) {
      return reply.code(409).send({
        error: 'mode_set_by_environment',
        message: 'The mode is set by SHARDLENS_MODE on the collector (or `mode` of an embedded one). Change it there.',
      });
    }
    if (patch.mode === 'audit' && !deps.config.auditKey) {
      return reply
        .code(400)
        .send({ error: 'audit_key_missing', message: 'Set SHARDLENS_AUDIT_KEY on the collector first.' });
    }
    // Every chart query converts with this zone, so PostgreSQL must know it too, not just this runtime.
    if (patch.timezone !== undefined) {
      const known = await deps.db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [patch.timezone]);
      if (!known.rowCount) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', issues: [{ path: ['timezone'], message: 'unknown time zone' }] });
      }
    }
    const columns: Record<string, unknown> = {};
    if (patch.timezone !== undefined) columns.timezone = patch.timezone;
    if (patch.rawRetentionDays !== undefined) columns.raw_retention_days = patch.rawRetentionDays;
    if (patch.mode !== undefined) columns.mode = patch.mode;
    if (patch.saltPeriod !== undefined) columns.salt_period = patch.saltPeriod;
    const names = Object.keys(columns);
    if (names.length > 0) {
      // Column names come from the fixed map above, never from input.
      const sets = names.map((n, i) => `${n} = $${i + 2}`).join(', ');
      await deps.db.query(`UPDATE apps SET ${sets} WHERE app_id = $1`, [admin.appId, ...names.map((n) => columns[n])]);
    }
    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      const value = (patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (value === null) {
        await deps.db.query('DELETE FROM settings WHERE app_id = $1 AND key = $2', [admin.appId, key]);
      } else {
        await deps.db.query(
          `INSERT INTO settings (app_id, key, value) VALUES ($1, $2, $3)
           ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [admin.appId, key, JSON.stringify(value)],
        );
      }
    }
    await adminAudit(deps, admin.appId, admin.userId, 'settings_update', { fields: Object.keys(patch) });
    return readSettings(deps, admin.appId);
  });

  app.get('/v1/keys', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply);
    if (!admin) return;
    const res = await deps.db.query(
      `SELECT id::text, scope, label, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
         FROM api_keys WHERE app_id = $1 ORDER BY created_at DESC`,
      [admin.appId],
    );
    return { rows: res.rows };
  });

  app.post('/v1/keys', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const body = z
      .object({ scope: z.enum(['ingest', 'read', 'activity']), label: z.string().min(1).max(64) })
      .strict()
      .parse(req.body ?? {});
    const key = newApiKey(body.scope);
    const res = await deps.db.query<{ id: string }>(
      'INSERT INTO api_keys (app_id, scope, sha256, label) VALUES ($1, $2, $3, $4) RETURNING id::text',
      [admin.appId, body.scope, Buffer.from(key.sha256, 'hex'), body.label],
    );
    await adminAudit(deps, admin.appId, admin.userId, 'key_create', {
      id: res.rows[0]?.id,
      scope: body.scope,
      label: body.label,
    });
    // Shown once; only the SHA-256 is stored.
    return reply.code(201).send({ id: res.rows[0]?.id, scope: body.scope, label: body.label, key: key.plaintext });
  });

  app.delete('/v1/keys/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    const res = await deps.db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE app_id = $1 AND id = $2 AND revoked_at IS NULL',
      [admin.appId, id],
    );
    deps.keys.clear();
    if (!res.rowCount) return reply.code(404).send({ error: 'not_found' });
    // "Anything using it stops working immediately": that includes dashboards signed in with it.
    await deps.db.query('DELETE FROM sessions WHERE key_id = $1', [id]);
    await adminAudit(deps, admin.appId, admin.userId, 'key_revoke', { id });
    return { ok: true };
  });

  app.get('/v1/alerts', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply);
    if (!admin) return;
    const rules = await deps.db.query<{
      id: string;
      name: string;
      metric: string;
      comparator: string;
      threshold: number;
      window_s: number;
      webhook_enc: Buffer;
      enabled: boolean;
      last_fired: Date | null;
    }>(
      'SELECT id::text, name, metric, comparator, threshold, window_s, webhook_enc, enabled, last_fired FROM alert_rules WHERE app_id = $1 ORDER BY id',
      [admin.appId],
    );
    const history = await deps.db.query(
      `SELECT e.ts, e.rule_id::text AS "ruleId", r.name, e.value, e.delivered, e.error
         FROM alert_events e JOIN alert_rules r ON r.id = e.rule_id
        WHERE e.app_id = $1 ORDER BY e.ts DESC LIMIT 50`,
      [admin.appId],
    );
    return {
      rules: rules.rows.map((r) => ({
        id: r.id,
        name: r.name,
        metric: r.metric,
        comparator: r.comparator,
        threshold: r.threshold,
        windowS: r.window_s,
        webhook: maskStoredWebhook(settingsCipher, r.webhook_enc),
        enabled: r.enabled,
        lastFired: r.last_fired,
      })),
      history: history.rows,
    };
  });

  app.post('/v1/alerts', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const body = AlertBody.parse(req.body ?? {});
    const res = await deps.db.query<{ id: string }>(
      `INSERT INTO alert_rules (app_id, name, metric, comparator, threshold, window_s, webhook_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
      [
        admin.appId,
        body.name,
        body.metric,
        body.comparator,
        body.threshold,
        body.windowS,
        settingsCipher.encrypt(body.webhookUrl),
      ],
    );
    await adminAudit(deps, admin.appId, admin.userId, 'alert_create', { id: res.rows[0]?.id, metric: body.metric });
    return reply.code(201).send({ id: res.rows[0]?.id });
  });

  app.patch('/v1/alerts/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    const { enabled } = EnabledBody.parse(req.body ?? {});
    const res = await deps.db.query('UPDATE alert_rules SET enabled = $3 WHERE app_id = $1 AND id = $2', [
      admin.appId,
      id,
      enabled,
    ]);
    if (!res.rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.delete('/v1/alerts/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    const res = await deps.db.query('DELETE FROM alert_rules WHERE app_id = $1 AND id = $2', [admin.appId, id]);
    if (!res.rowCount) return reply.code(404).send({ error: 'not_found' });
    await adminAudit(deps, admin.appId, admin.userId, 'alert_delete', { id });
    return { ok: true };
  });

  app.post(
    '/v1/alerts/:id/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const admin = await requireAdmin(deps, req, reply, { mutate: true });
      if (!admin) return;
      const { id } = IdParam.parse(req.params);
      const rule = await deps.db.query<{ name: string; webhook_enc: Buffer }>(
        'SELECT name, webhook_enc FROM alert_rules WHERE app_id = $1 AND id = $2',
        [admin.appId, id],
      );
      const row = rule.rows[0];
      if (!row) return reply.code(404).send({ error: 'not_found' });
      let url: string;
      try {
        url = settingsCipher.decrypt(row.webhook_enc);
      } catch {
        return reply.code(502).send({ error: 'webhook_failed', message: UNREADABLE_WEBHOOK });
      }
      const result = await postToDiscordWebhook(url, {
        title: `Test: ${row.name}`,
        body: 'This is a test message from Shardlens. Alerts for this rule will look like this.',
        link: dashboardUrl(deps.config) && new URL('/reliability', deps.config.publicUrl).toString(),
        critical: false,
      });
      return result.ok ? { ok: true } : reply.code(502).send({ error: 'webhook_failed', message: result.error });
    },
  );
}
