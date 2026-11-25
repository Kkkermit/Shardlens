import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isDiscordWebhookUrl, maskStoredWebhook } from '../discord-webhook.js';
import { dashboardUrl } from '../env.js';
import { REPORT_SCHEDULES, sendReportNow } from '../jobs/reports.js';
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
    const reports = await deps.store.reports.list(admin.appId);
    const appRecord = await deps.store.apps.get(admin.appId);
    return {
      timezone: appRecord?.timezone ?? 'UTC',
      reports: reports.map((r) => ({
        id: r.id,
        name: r.name,
        schedule: r.schedule,
        hour: r.hour,
        weekday: r.weekday,
        webhook: maskStoredWebhook(cipher, r.webhook),
        enabled: r.enabled,
        lastSent: r.lastSent,
        lastError: r.lastError,
      })),
    };
  });

  app.post('/v1/reports', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const body = ReportBody.parse(req.body ?? {});
    if ((await deps.store.reports.count(admin.appId)) >= MAX_REPORTS) {
      return reply.code(400).send({ error: 'too_many_reports', message: `At most ${MAX_REPORTS} reports.` });
    }
    const id = await deps.store.reports.create(admin.appId, {
      name: body.name,
      schedule: body.schedule,
      hour: body.hour,
      weekday: body.weekday,
      webhook: cipher.encrypt(body.webhookUrl),
    });
    await deps.store.adminAudit.record(admin.appId, admin.userId, 'report_create', { id, schedule: body.schedule });
    return reply.code(201).send({ id });
  });

  app.patch('/v1/reports/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    const { enabled } = EnabledBody.parse(req.body ?? {});
    if (!(await deps.store.reports.setEnabled(admin.appId, id, enabled))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { ok: true };
  });

  app.delete('/v1/reports/:id', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply, { mutate: true });
    if (!admin) return;
    const { id } = IdParam.parse(req.params);
    if (!(await deps.store.reports.delete(admin.appId, id))) return reply.code(404).send({ error: 'not_found' });
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
      const result = await sendReportNow(deps.store, admin.appId, id, {
        settingsKey: deps.config.settingsKey,
        dashboardUrl: dashboardUrl(deps.config),
      });
      if (!result) return reply.code(404).send({ error: 'not_found' });
      return result.ok ? { ok: true } : reply.code(502).send({ error: 'webhook_failed', message: result.error });
    },
  );
}
