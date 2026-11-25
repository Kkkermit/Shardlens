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
import type { AppRecord, SettingKey, SettingValues } from '../storage/store.js';
import { requireAdmin } from './guard.js';

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

/** Keys from the environment carry their variable's name as label, and a new value revokes keys with that label. */
export const KeyLabel = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (label) => !/^SHARDLENS_[A-Z]+_KEY$/.test(label.trim()),
    'names like SHARDLENS_READ_KEY are kept for keys from the environment',
  );

/** The path parameter of a key, an alert or a report. */
export const IdParam = z.object({ id: z.string().regex(/^\d{1,18}$/) });

/** Turns an alert or a report on or off. */
export const EnabledBody = z.object({ enabled: z.boolean() }).strict();

const SETTING_KEYS: Record<string, SettingKey> = {
  auditRetentionDays: 'audit_retention_days',
  requiredPermissions: 'required_permissions',
  skuPrices: 'sku_prices',
  sampling: 'sampling',
  badges: 'badges',
};

async function readSettings(deps: Deps, appId: string) {
  const a = await deps.store.apps.get(appId);
  const s = await deps.store.settings.all(appId);
  return {
    timezone: a?.timezone ?? 'UTC',
    rawRetentionDays: a?.rawRetentionDays ?? 35,
    auditRetentionDays: s.audit_retention_days ?? 30,
    mode: a?.mode ?? 'privacy',
    saltPeriod: a?.saltPeriod ?? 'month',
    requiredPermissions: s.required_permissions ?? null,
    skuPrices: s.sku_prices ?? {},
    sampling: s.sampling ?? {},
    badges: s.badges ?? [],
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
    // Every chart query converts with this zone, so the store must know it too, not just this runtime.
    if (patch.timezone !== undefined) {
      if (!(await deps.store.settings.supportsTimeZone(patch.timezone))) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', issues: [{ path: ['timezone'], message: 'unknown time zone' }] });
      }
    }
    const changes: Partial<AppRecord> = {};
    if (patch.timezone !== undefined) changes.timezone = patch.timezone;
    if (patch.rawRetentionDays !== undefined) changes.rawRetentionDays = patch.rawRetentionDays;
    if (patch.mode !== undefined) changes.mode = patch.mode;
    if (patch.saltPeriod !== undefined) changes.saltPeriod = patch.saltPeriod;
    await deps.store.apps.update(admin.appId, changes);
    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      const value = (patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (value === null) await deps.store.settings.delete(admin.appId, key);
      else await deps.store.settings.set(admin.appId, key, value as SettingValues[SettingKey]);
    }
    await deps.store.adminAudit.record(admin.appId, admin.userId, 'settings_update', { fields: Object.keys(patch) });
    return readSettings(deps, admin.appId);
  });

  app.get('/v1/keys', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply);
    if (!admin) return;
    return { rows: await deps.store.keys.list(admin.appId) };
  });

  app.post('/v1/keys', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const body = z
      .object({ scope: z.enum(['ingest', 'read', 'activity']), label: KeyLabel })
      .strict()
      .parse(req.body ?? {});
    const key = newApiKey(body.scope);
    const id = await deps.store.keys.create({
      appId: admin.appId,
      scope: body.scope,
      sha256: Buffer.from(key.sha256, 'hex'),
      label: body.label,
    });
    await deps.store.adminAudit.record(admin.appId, admin.userId, 'key_create', {
      id,
      scope: body.scope,
      label: body.label,
    });
    // Shown once; only the SHA-256 is stored.
    return reply.code(201).send({ id, scope: body.scope, label: body.label, key: key.plaintext });
  });

  app.delete('/v1/keys/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    const revoked = await deps.store.keys.revoke(admin.appId, id);
    deps.keys.clear();
    if (!revoked) return reply.code(404).send({ error: 'not_found' });
    // "Anything using it stops working immediately": that includes dashboards signed in with it.
    await deps.store.sessions.deleteForKey(id);
    await deps.store.adminAudit.record(admin.appId, admin.userId, 'key_revoke', { id });
    return { ok: true };
  });

  app.get('/v1/alerts', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply);
    if (!admin) return;
    const rules = await deps.store.alerts.list(admin.appId);
    const history = await deps.store.alerts.history(admin.appId);
    return {
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        metric: r.metric,
        comparator: r.comparator,
        threshold: r.threshold,
        windowS: r.windowS,
        webhook: maskStoredWebhook(settingsCipher, r.webhook),
        enabled: r.enabled,
        lastFired: r.lastFired,
      })),
      history,
    };
  });

  app.post('/v1/alerts', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const body = AlertBody.parse(req.body ?? {});
    const id = await deps.store.alerts.create(admin.appId, {
      name: body.name,
      metric: body.metric,
      comparator: body.comparator,
      threshold: body.threshold,
      windowS: body.windowS,
      webhook: settingsCipher.encrypt(body.webhookUrl),
    });
    await deps.store.adminAudit.record(admin.appId, admin.userId, 'alert_create', { id, metric: body.metric });
    return reply.code(201).send({ id });
  });

  app.patch('/v1/alerts/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    const { enabled } = EnabledBody.parse(req.body ?? {});
    if (!(await deps.store.alerts.setEnabled(admin.appId, id, enabled))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { ok: true };
  });

  app.delete('/v1/alerts/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    if (!(await deps.store.alerts.delete(admin.appId, id))) return reply.code(404).send({ error: 'not_found' });
    await deps.store.adminAudit.record(admin.appId, admin.userId, 'alert_delete', { id });
    return { ok: true };
  });

  app.post(
    '/v1/alerts/:id/test',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const admin = await requireAdmin(deps, req, reply, { mutate: true });
      if (!admin) return;
      const { id } = IdParam.parse(req.params);
      const row = await deps.store.alerts.get(admin.appId, id);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      let url: string;
      try {
        url = settingsCipher.decrypt(row.webhook);
      } catch {
        return reply.code(502).send({ error: 'webhook_failed', message: UNREADABLE_WEBHOOK });
      }
      const dashboard = dashboardUrl(deps.config);
      const result = await postToDiscordWebhook(url, {
        title: `Test: ${row.name}`,
        body: 'This is a test message from Shardlens. Alerts for this rule will look like this.',
        link: dashboard && new URL('/reliability', dashboard).toString(),
        critical: false,
      });
      return result.ok ? { ok: true } : reply.code(502).send({ error: 'webhook_failed', message: result.error });
    },
  );
}
