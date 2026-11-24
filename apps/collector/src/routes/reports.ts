import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isDiscordWebhookUrl, maskStoredWebhook } from '../discord-webhook.js';
import { dashboardUrl } from '../env.js';
import { REPORT_SCHEDULES, type ReportSchedule, sendReportNow } from '../jobs/reports.js';
import { auditCipher } from '../security/crypto.js';
import type { Deps } from '../server.js';
import { EnabledBody, IdParam } from './admin.js';
import { requireAdmin } from './guard.js';

const MAX_REPORTS = 10;

export const ReportBody = z
  .object({
    name: z.string().trim().min(1).max(64),
    schedule: z.enum(REPORT_SCHEDULES),
    /** Hour of the day to send at, in the app's time zone. */
    hour: z.number().int().min(0).max(23),
    /** ISO weekday (1 Monday to 7 Sunday). Weekly reports only. */
    weekday: z.number().int().min(1).max(7).default(1),
    webhookUrl: z
      .string()
      .max(300)
      .refine(isDiscordWebhookUrl, 'must be a Discord webhook URL (https://discord.com/api/webhooks/…)'),
  })
  .strict();

/** Scheduled reports: a daily or weekly summary posted to a Discord channel through its webhook. */
export async function reportRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const cipher = auditCipher(deps.config.settingsKey);

  app.get('/v1/reports', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply);
    if (!admin) return;
    const rows = await deps.db.query<{
      id: string;
      name: string;
      schedule: ReportSchedule;
      hour: number;
      weekday: number;
      webhook_enc: Buffer;
      enabled: boolean;
      last_sent: Date | null;
      last_error: string | null;
    }>(
      `SELECT id::text, name, schedule, hour, weekday, webhook_enc, enabled, last_sent, last_error
         FROM reports WHERE app_id = $1 ORDER BY id`,
      [admin.appId],
    );
    const app = await deps.store.apps.get(admin.appId);
    return {
      timezone: app?.timezone ?? 'UTC',
      reports: rows.rows.map((r) => ({
        id: r.id,
        name: r.name,
        schedule: r.schedule,
        hour: r.hour,
        weekday: r.weekday,
        webhook: maskStoredWebhook(cipher, r.webhook_enc),
        enabled: r.enabled,
        lastSent: r.last_sent,
        lastError: r.last_error,
      })),
    };
  });

  app.post('/v1/reports', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const body = ReportBody.parse(req.body ?? {});
    const existing = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM reports WHERE app_id = $1', [
      admin.appId,
    ]);
    if ((existing.rows[0]?.n ?? 0) >= MAX_REPORTS) {
      return reply.code(400).send({ error: 'too_many_reports', message: `At most ${MAX_REPORTS} reports.` });
    }
    const res = await deps.db.query<{ id: string }>(
      `INSERT INTO reports (app_id, name, schedule, hour, weekday, webhook_enc)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
      [admin.appId, body.name, body.schedule, body.hour, body.weekday, cipher.encrypt(body.webhookUrl)],
    );
    await deps.store.adminAudit.record(admin.appId, admin.userId, 'report_create', {
      id: res.rows[0]?.id,
      schedule: body.schedule,
    });
    return reply.code(201).send({ id: res.rows[0]?.id });
  });

  app.patch('/v1/reports/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    const { enabled } = EnabledBody.parse(req.body ?? {});
    const res = await deps.db.query('UPDATE reports SET enabled = $3 WHERE app_id = $1 AND id = $2', [
      admin.appId,
      id,
      enabled,
    ]);
    if (!res.rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.delete('/v1/reports/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    const res = await deps.db.query('DELETE FROM reports WHERE app_id = $1 AND id = $2', [admin.appId, id]);
    if (!res.rowCount) return reply.code(404).send({ error: 'not_found' });
    await deps.store.adminAudit.record(admin.appId, admin.userId, 'report_delete', { id });
    return { ok: true };
  });

  app.post(
    '/v1/reports/:id/send',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const admin = await requireAdmin(deps, req, reply, { mutate: true });
      if (!admin) return;
      const { id } = IdParam.parse(req.params);
      const result = await sendReportNow(deps.db, admin.appId, id, {
        settingsKey: deps.config.settingsKey,
        dashboardUrl: dashboardUrl(deps.config),
      });
      if (!result) return reply.code(404).send({ error: 'not_found' });
      return result.ok ? { ok: true } : reply.code(502).send({ error: 'webhook_failed', message: result.error });
    },
  );
}
