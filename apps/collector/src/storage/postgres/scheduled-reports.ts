import type { Db } from '../../db.js';
import type { ReportSchedule } from '../../jobs/reports.js';
import type { ReportStorage, ReportToSend } from '../store.js';

/**
 * Reports with their period boundaries, computed in each app's time zone by PostgreSQL. With `due`, only the ones
 * whose hour has come (and weekday, for weekly reports) and that have not been sent yet today.
 */
async function selectReports(
  db: Db,
  now: Date,
  filter: { due: true } | { appId: string; id: string },
): Promise<ReportToSend[]> {
  const params: unknown[] = [now];
  let where: string;
  if ('due' in filter) {
    where = `r.enabled
       AND extract(hour FROM t.local) >= r.hour
       AND (r.schedule = 'daily' OR extract(isodow FROM t.local) = r.weekday)
       AND (r.last_sent IS NULL OR r.last_sent < t.today AT TIME ZONE a.timezone)`;
  } else {
    params.push(filter.appId, filter.id);
    where = 'r.app_id = $2 AND r.id = $3';
  }
  const res = await db.query<{
    id: string;
    app_id: string;
    name: string;
    schedule: ReportSchedule;
    webhook_enc: Buffer;
    timezone: string;
    bot: string;
    day_start: Date;
    week_start: Date;
    day_end: Date;
  }>(
    `SELECT r.id::text AS id, r.app_id::text AS app_id, r.name, r.schedule, r.webhook_enc, a.timezone,
            coalesce(nullif(a.name, ''), i.name, 'Your bot') AS bot,
            (t.today - interval '1 day') AT TIME ZONE a.timezone AS day_start,
            (t.today - interval '7 days') AT TIME ZONE a.timezone AS week_start,
            t.today AT TIME ZONE a.timezone AS day_end
       FROM reports r
       JOIN apps a USING (app_id)
       LEFT JOIN app_info i USING (app_id)
      CROSS JOIN LATERAL (SELECT $1::timestamptz AT TIME ZONE a.timezone AS local,
                                 date_trunc('day', $1::timestamptz AT TIME ZONE a.timezone) AS today) t
      WHERE ${where}
      ORDER BY r.id`,
    params,
  );
  return res.rows.map((r) => ({
    id: r.id,
    appId: r.app_id,
    name: r.name,
    schedule: r.schedule,
    webhook: r.webhook_enc,
    timezone: r.timezone,
    bot: r.bot,
    dayStart: r.day_start,
    weekStart: r.week_start,
    dayEnd: r.day_end,
  }));
}

export function postgresReports(db: Db): ReportStorage {
  return {
    async list(appId) {
      const rows = await db.query<{
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
        [appId],
      );
      return rows.rows.map((r) => ({
        id: r.id,
        name: r.name,
        schedule: r.schedule,
        hour: r.hour,
        weekday: r.weekday,
        webhook: r.webhook_enc,
        enabled: r.enabled,
        lastSent: r.last_sent,
        lastError: r.last_error,
      }));
    },

    async count(appId) {
      const existing = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM reports WHERE app_id = $1', [
        appId,
      ]);
      return existing.rows[0]?.n ?? 0;
    },

    async create(appId, report) {
      const res = await db.query<{ id: string }>(
        `INSERT INTO reports (app_id, name, schedule, hour, weekday, webhook_enc)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
        [appId, report.name, report.schedule, report.hour, report.weekday, report.webhook],
      );
      return res.rows[0]!.id;
    },

    async setEnabled(appId, id, enabled) {
      const res = await db.query('UPDATE reports SET enabled = $3 WHERE app_id = $1 AND id = $2', [appId, id, enabled]);
      return Boolean(res.rowCount);
    },

    async delete(appId, id) {
      const res = await db.query('DELETE FROM reports WHERE app_id = $1 AND id = $2', [appId, id]);
      return Boolean(res.rowCount);
    },

    due: (now) => selectReports(db, now, { due: true }),

    async find(appId, id, now) {
      const [row] = await selectReports(db, now, { appId, id });
      return row;
    },

    async recordSent(id, at, error) {
      await db.query('UPDATE reports SET last_sent = $2, last_error = $3 WHERE id = $1', [id, at, error]);
    },
  };
}
