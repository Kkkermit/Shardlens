import type { Db } from '../db.js';
import { postToDiscordWebhook } from '../discord-webhook.js';
import { runQuery } from '../query/run.js';
import { QuerySpec } from '../query/spec.js';
import { auditCipher } from '../security/crypto.js';

export const REPORT_SCHEDULES = ['daily', 'weekly'] as const;
export type ReportSchedule = (typeof REPORT_SCHEDULES)[number];

interface ReportRow {
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
}

export interface ReportOptions {
  settingsKey: string;
  publicUrl: URL;
  fetchImpl?: typeof fetch;
}

/** The parts of the query results a report reads. */
interface Totals {
  runs: number | null;
  missedDeadlines: number | null;
  errors: number | null;
  p95Ms: number | null;
}
interface CommandRow {
  command: string;
  runs: number;
  previousRuns: number;
}
interface GrowthDay {
  joins: number | null;
  leaves: number | null;
}
interface AudienceDay {
  day: string;
  users: number;
  newUsers: number;
}

const count = new Intl.NumberFormat('en');
/** Names come from Discord or from the SDK: no control characters (new lines) and no backticks reach a message. */
const plain = (text: string) => text.replace(/[\p{Cc}`]/gu, '');
const share = (part: number, whole: number) => `${((100 * part) / whole).toFixed(part / whole < 0.1 ? 1 : 0)}%`;

function periodLabel(row: Pick<ReportRow, 'schedule' | 'timezone' | 'day_start' | 'week_start' | 'day_end'>): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: row.timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  if (row.schedule === 'daily') return day.format(row.day_start);
  return `${day.format(row.week_start)} to ${day.format(new Date(row.day_end.getTime() - 1))}`;
}

/** The summary for one finished day or week. Counts only: nothing in a report identifies a user. */
async function buildReport(db: Db, row: ReportRow, now: Date): Promise<{ title: string; body: string }> {
  const from = row.schedule === 'daily' ? row.day_start : row.week_start;
  const range = { from: from.toISOString(), to: row.day_end.toISOString() };
  const [reliability, commands, growth, audience] = (await Promise.all([
    runQuery(db, row.app_id, QuerySpec.parse({ kind: 'reliability', range }), now),
    runQuery(db, row.app_id, QuerySpec.parse({ kind: 'commands', range }), now),
    runQuery(db, row.app_id, QuerySpec.parse({ kind: 'growth', range, timezone: row.timezone }), now),
    runQuery(db, row.app_id, QuerySpec.parse({ kind: 'audience', range }), now),
  ])) as [
    { totals: Totals | null },
    { rows: CommandRow[] },
    { daily: GrowthDay[]; serverCount: { ours: number } },
    { daily: AudienceDay[] },
  ];

  const unit = row.schedule === 'daily' ? 'day' : 'week';
  const used = commands.rows.filter((c) => c.runs > 0).sort((a, b) => b.runs - a.runs);
  const runs = used.reduce((sum, c) => sum + c.runs, 0);
  const previous = commands.rows.reduce((sum, c) => sum + c.previousRuns, 0);
  const lines: string[] = [`**${periodLabel(row)}** (${row.timezone})`, ''];

  if (runs === 0) {
    lines.push(`No commands were run this ${unit}.`);
  } else {
    const change =
      previous > 0
        ? ` (${runs >= previous ? '▲' : '▼'} ${Math.abs((100 * (runs - previous)) / previous).toFixed(1)}% on the ${unit} before)`
        : '';
    lines.push(`Commands run: **${count.format(Math.round(runs))}**${change}`);

    // Unique users are counted per UTC day. A day or week in the report's time zone takes the UTC days whose midday
    // falls inside it: one per local day, the one that overlaps it most.
    const days = audience.daily.filter((d) => {
      const midday = Date.parse(`${d.day}T12:00:00Z`);
      return midday >= from.getTime() && midday < row.day_end.getTime();
    });
    const [day] = days;
    if (day && row.schedule === 'daily') {
      lines.push(`Unique users: **${count.format(day.users)}** (${count.format(day.newUsers)} new)`);
    } else if (day) {
      const average = days.reduce((sum, d) => sum + d.users, 0) / days.length;
      lines.push(`Unique users a day, on average: **${count.format(Math.round(average))}**`);
    }

    const t = reliability.totals;
    if (t?.runs) {
      const health = [
        `Failed: **${share(t.errors ?? 0, t.runs)}**`,
        `Missed the 3-second deadline: **${share(t.missedDeadlines ?? 0, t.runs)}**`,
      ];
      if (t.p95Ms !== null) health.push(`p95 response: **${count.format(Math.round(t.p95Ms))} ms**`);
      lines.push(health.join(' · '));
    }
  }

  const joined = growth.daily.reduce((sum, d) => sum + (d.joins ?? 0), 0);
  const left = growth.daily.reduce((sum, d) => sum + (d.leaves ?? 0), 0);
  lines.push(
    `Servers: **${count.format(growth.serverCount.ours)}** (+${count.format(joined)} joined, −${count.format(left)} left)`,
  );

  if (used.length > 0) {
    lines.push('', '**Top commands**');
    used.slice(0, 5).forEach((c, i) => {
      // Inside a code span, so a name can't add formatting of its own.
      lines.push(`${i + 1}. \`/${plain(c.command)}\` · ${count.format(Math.round(c.runs))}`);
    });
  }

  return {
    title: `📊 ${row.schedule === 'daily' ? 'Daily' : 'Weekly'} report · ${plain(row.bot)}`,
    body: lines.join('\n'),
  };
}

/**
 * Reports with their period boundaries, computed in each app's time zone by PostgreSQL. With `due`, only the ones
 * whose hour has come (and weekday, for weekly reports) and that have not been sent yet today.
 */
async function selectReports(db: Db, now: Date, filter: { due: true } | { appId: string; id: string }) {
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
  const res = await db.query<ReportRow>(
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
  return res.rows;
}

type Delivery = { ok: boolean; error?: string };

/** One attempt per period, successful or not: a deleted webhook must not be retried every few minutes all day. */
async function record(db: Db, row: ReportRow, now: Date, result: Delivery): Promise<Delivery> {
  await db.query('UPDATE reports SET last_sent = $2, last_error = $3 WHERE id = $1', [
    row.id,
    now,
    result.ok ? null : (result.error ?? 'failed'),
  ]);
  return result;
}

async function send(db: Db, row: ReportRow, opts: ReportOptions, now: Date): Promise<Delivery> {
  let url: string;
  try {
    url = auditCipher(opts.settingsKey).decrypt(row.webhook_enc);
  } catch {
    // Usually a changed SHARDLENS_SETTINGS_KEY.
    return record(db, row, now, {
      ok: false,
      error: 'The saved webhook could not be decrypted. Save the report again.',
    });
  }
  const report = await buildReport(db, row, now);
  const message = { ...report, link: new URL('/', opts.publicUrl).toString(), critical: false };
  return record(db, row, now, await postToDiscordWebhook(url, message, opts.fetchImpl));
}

/** Sends every report that is due. Returns how many were delivered. */
export async function runReports(db: Db, opts: ReportOptions, now = new Date()): Promise<number> {
  let delivered = 0;
  for (const row of await selectReports(db, now, { due: true })) {
    if ((await send(db, row, opts, now)).ok) delivered++;
  }
  return delivered;
}

/** Sends one report now, for its last finished period, whether or not it is due. */
export async function sendReportNow(
  db: Db,
  appId: string,
  id: string,
  opts: ReportOptions,
  now = new Date(),
): Promise<Delivery | undefined> {
  const [row] = await selectReports(db, now, { appId, id });
  return row ? send(db, row, opts, now) : undefined;
}
