import type { Db } from '../db.js';
import { postToDiscordWebhook } from '../discord-webhook.js';
import { INTERACTIONS_ONLY_SQL } from '../ingest/codes.js';
import { auditCipher } from '../security/crypto.js';

/** Usually a changed `SHARDLENS_SETTINGS_KEY`. */
export const UNREADABLE_WEBHOOK = 'The saved webhook could not be decrypted. Save the alert again.';

/** Minimum time between two notifications for the same rule. */
const ALERT_DEBOUNCE_MS = 30 * 60_000;

const LABELS: Record<string, { label: string; unit: (v: number) => string }> = {
  missed_deadline_rate: { label: 'Missed 3-second deadlines', unit: (v) => `${v.toFixed(2)}%` },
  error_rate: { label: 'Failed interactions', unit: (v) => `${v.toFixed(2)}%` },
  p95_ms: { label: 'p95 response time', unit: (v) => `${Math.round(v)} ms` },
  invalid_requests_pct: {
    label: 'Invalid-request budget used (of 10,000 per 10 min)',
    unit: (v) => `${v.toFixed(1)}%`,
  },
  stale_shards: { label: 'Shards not reporting', unit: (v) => String(Math.round(v)) },
  interactions_per_min: { label: 'Interactions per minute', unit: (v) => v.toFixed(1) },
  identify_remaining: { label: 'Identify calls left (24 h)', unit: (v) => String(Math.round(v)) },
};

/**
 * Current value of an alert metric over the trailing window. Every query is a constant; only app ID and window are
 * bound. Returns `null` when there is no data (no alert fires on missing data).
 */
export async function evaluateMetric(db: Db, appId: string, metric: string, windowS: number): Promise<number | null> {
  const p = [appId, `${windowS} seconds`];
  switch (metric) {
    case 'missed_deadline_rate':
    case 'error_rate': {
      const cond = metric === 'missed_deadline_rate' ? 'outcome IN (2, 3)' : 'outcome <> 0';
      // Message commands have no deadline to miss, so they don't count towards that rate.
      const scope = metric === 'missed_deadline_rate' ? ` AND ${INTERACTIONS_ONLY_SQL}` : '';
      const r = await db.query<{ v: number | null }>(
        `SELECT 100.0 * sum(weight) FILTER (WHERE ${cond}) / nullif(sum(weight), 0) AS v
           FROM interactions WHERE app_id = $1 AND ts > now() - $2::interval${scope}`,
        p,
      );
      return r.rows[0]?.v ?? null;
    }
    case 'p95_ms': {
      const r = await db.query<{ v: number | null }>(
        `SELECT shardlens_hist_quantile(shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)), 0.95) AS v
           FROM interactions WHERE app_id = $1 AND ts > now() - $2::interval`,
        p,
      );
      return r.rows[0]?.v ?? null;
    }
    case 'invalid_requests_pct': {
      // Discord's ban threshold counts the last 10 minutes regardless of the rule's window.
      const r = await db.query<{ v: number | null }>(
        `SELECT 100.0 * sum(count401 + count403 + count429) / 10000 AS v
           FROM rest_invalid WHERE app_id = $1 AND ts > now() - interval '10 minutes'`,
        [appId],
      );
      return r.rows[0]?.v ?? 0;
    }
    case 'stale_shards': {
      const r = await db.query<{ v: number }>(
        `SELECT count(*)::int AS v FROM (
           SELECT shard, max(ts) AS last FROM gauges
            WHERE app_id = $1 AND name = 'shard.ping_ms' AND ts > now() - interval '1 day' GROUP BY shard
         ) s WHERE last < now() - $2::interval`,
        p,
      );
      return r.rows[0]?.v ?? 0;
    }
    case 'interactions_per_min': {
      const r = await db.query<{ v: number | null }>(
        `SELECT coalesce(sum(weight), 0) / ($3::float8 / 60) AS v
           FROM interactions WHERE app_id = $1 AND ts > now() - $2::interval`,
        [...p, windowS],
      );
      return r.rows[0]?.v ?? null;
    }
    case 'identify_remaining': {
      const r = await db.query<{ v: number | null }>(
        'SELECT session_start_remaining AS v FROM app_info WHERE app_id = $1',
        [appId],
      );
      return r.rows[0]?.v ?? null;
    }
    default:
      return null;
  }
}

function breaches(value: number, comparator: string, threshold: number): boolean {
  switch (comparator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    default:
      return false;
  }
}

/** Evaluates every enabled alert rule; notifies at most once per rule per 30 minutes. */
export async function runAlerts(
  db: Db,
  opts: { settingsKey: string; dashboardUrl: URL | undefined; fetchImpl?: typeof fetch },
  now = new Date(),
): Promise<number> {
  const cipher = auditCipher(opts.settingsKey);
  const rules = await db.query<{
    id: string;
    app_id: string;
    name: string;
    metric: string;
    comparator: string;
    threshold: number;
    window_s: number;
    webhook_enc: Buffer;
    last_fired: Date | null;
  }>(
    'SELECT id, app_id, name, metric, comparator, threshold, window_s, webhook_enc, last_fired FROM alert_rules WHERE enabled',
  );
  let fired = 0;
  for (const rule of rules.rows) {
    if (rule.last_fired && now.getTime() - rule.last_fired.getTime() < ALERT_DEBOUNCE_MS) continue;
    const value = await evaluateMetric(db, rule.app_id, rule.metric, rule.window_s);
    if (value === null || !breaches(value, rule.comparator, rule.threshold)) continue;
    const meta = LABELS[rule.metric] ?? { label: rule.metric, unit: (v: number) => String(v) };
    let url: string;
    try {
      url = cipher.decrypt(rule.webhook_enc);
    } catch {
      // Shown in the alert's history instead of failing silently.
      await db.query('UPDATE alert_rules SET last_fired = $2 WHERE id = $1', [rule.id, now]);
      await db.query(
        'INSERT INTO alert_events (rule_id, app_id, ts, value, delivered, error) VALUES ($1, $2, $3, $4, false, $5)',
        [rule.id, rule.app_id, now, value, UNREADABLE_WEBHOOK],
      );
      continue;
    }
    const minutes = Math.round(rule.window_s / 60);
    const result = await postToDiscordWebhook(
      url,
      {
        title: `🔔 ${rule.name}`,
        body: `${meta.label}: **${meta.unit(value)}** (rule: ${rule.comparator} ${meta.unit(rule.threshold)}, last ${minutes} min)`,
        link: opts.dashboardUrl && new URL('/reliability', opts.dashboardUrl).toString(),
        critical: true,
      },
      opts.fetchImpl,
    );
    await db.query('UPDATE alert_rules SET last_fired = $2 WHERE id = $1', [rule.id, now]);
    await db.query(
      'INSERT INTO alert_events (rule_id, app_id, ts, value, delivered, error) VALUES ($1, $2, $3, $4, $5, $6)',
      [rule.id, rule.app_id, now, value, result.ok, result.error ?? null],
    );
    fired++;
  }
  return fired;
}
