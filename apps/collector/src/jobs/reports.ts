import { postToDiscordWebhook } from '../discord-webhook.js';
import { runQuery } from '../query/run.js';
import { QuerySpec } from '../query/spec.js';
import { auditCipher } from '../security/crypto.js';
import type { ReportToSend, Store } from '../storage/store.js';

export const REPORT_SCHEDULES = ['daily', 'weekly'] as const;
export type ReportSchedule = (typeof REPORT_SCHEDULES)[number];

interface ReportOptions {
  settingsKey: string;
  dashboardUrl: URL | undefined;
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
  kinds: string[];
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

function periodLabel(row: Pick<ReportToSend, 'schedule' | 'timezone' | 'dayStart' | 'weekStart' | 'dayEnd'>): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: row.timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  if (row.schedule === 'daily') return day.format(row.dayStart);
  return `${day.format(row.weekStart)} to ${day.format(new Date(row.dayEnd.getTime() - 1))}`;
}

/** The summary for one finished day or week. Counts only: nothing in a report identifies a user. */
async function buildReport(store: Store, row: ReportToSend, now: Date): Promise<{ title: string; body: string }> {
  const from = row.schedule === 'daily' ? row.dayStart : row.weekStart;
  const range = { from: from.toISOString(), to: row.dayEnd.toISOString() };
  const [reliability, commands, growth, audience] = (await Promise.all([
    runQuery(store, row.appId, QuerySpec.parse({ kind: 'reliability', range }), now),
    runQuery(store, row.appId, QuerySpec.parse({ kind: 'commands', range }), now),
    runQuery(store, row.appId, QuerySpec.parse({ kind: 'growth', range, timezone: row.timezone }), now),
    runQuery(store, row.appId, QuerySpec.parse({ kind: 'audience', range }), now),
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
      return midday >= from.getTime() && midday < row.dayEnd.getTime();
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
      const slash = c.kinds.includes('chat_input') ? '/' : '';
      lines.push(`${i + 1}. \`${slash}${plain(c.command)}\` · ${count.format(Math.round(c.runs))}`);
    });
  }

  return {
    title: `📊 ${row.schedule === 'daily' ? 'Daily' : 'Weekly'} report · ${plain(row.bot)}`,
    body: lines.join('\n'),
  };
}

type Delivery = { ok: boolean; error?: string };

/** One attempt per period, successful or not: a deleted webhook must not be retried every few minutes all day. */
async function record(store: Store, row: ReportToSend, now: Date, result: Delivery): Promise<Delivery> {
  await store.reports.recordSent(row.id, now, result.ok ? null : (result.error ?? 'failed'));
  return result;
}

async function send(store: Store, row: ReportToSend, opts: ReportOptions, now: Date): Promise<Delivery> {
  let url: string;
  try {
    url = auditCipher(opts.settingsKey).decrypt(row.webhook);
  } catch {
    // Usually a changed SHARDLENS_SETTINGS_KEY.
    return record(store, row, now, {
      ok: false,
      error: 'The saved webhook could not be decrypted. Save the report again.',
    });
  }
  const report = await buildReport(store, row, now);
  const message = { ...report, link: opts.dashboardUrl && new URL('/', opts.dashboardUrl).toString(), critical: false };
  return record(store, row, now, await postToDiscordWebhook(url, message, opts.fetchImpl));
}

/** Sends every report that is due. Returns how many were delivered. */
export async function runReports(store: Store, opts: ReportOptions, now = new Date()): Promise<number> {
  let delivered = 0;
  for (const row of await store.reports.due(now)) {
    if ((await send(store, row, opts, now)).ok) delivered++;
  }
  return delivered;
}

/** Sends one report now, for its last finished period, whether or not it is due. */
export async function sendReportNow(
  store: Store,
  appId: string,
  id: string,
  opts: ReportOptions,
  now = new Date(),
): Promise<Delivery | undefined> {
  const row = await store.reports.find(appId, id, now);
  return row ? send(store, row, opts, now) : undefined;
}
