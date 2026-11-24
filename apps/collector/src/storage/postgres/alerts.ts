import type { Db } from '../../db.js';
import { INTERACTIONS_ONLY_SQL } from '../../ingest/codes.js';
import type { AlertFiring, AlertRule, AlertStorage } from '../store.js';

interface RuleRow {
  id: string;
  app_id: string;
  name: string;
  metric: string;
  comparator: AlertRule['comparator'];
  threshold: number;
  window_s: number;
  webhook_enc: Buffer;
  enabled: boolean;
  last_fired: Date | null;
}

/**
 * Current value of an alert metric over the trailing window. Every query is a constant; only app ID and window are
 * bound. Returns `null` when there is no data (no alert fires on missing data).
 */
async function evaluateMetric(db: Db, appId: string, metric: string, windowS: number): Promise<number | null> {
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

export function postgresAlerts(db: Db): AlertStorage {
  return {
    async list(appId) {
      const rules = await db.query<RuleRow>(
        'SELECT id::text, name, metric, comparator, threshold, window_s, webhook_enc, enabled, last_fired FROM alert_rules WHERE app_id = $1 ORDER BY id',
        [appId],
      );
      return rules.rows.map((r) => ({
        id: r.id,
        name: r.name,
        metric: r.metric,
        comparator: r.comparator,
        threshold: r.threshold,
        windowS: r.window_s,
        webhook: r.webhook_enc,
        enabled: r.enabled,
        lastFired: r.last_fired,
      }));
    },

    async history(appId) {
      const history = await db.query<AlertFiring>(
        `SELECT e.ts, e.rule_id::text AS "ruleId", r.name, e.value, e.delivered, e.error
           FROM alert_events e JOIN alert_rules r ON r.id = e.rule_id
          WHERE e.app_id = $1 ORDER BY e.ts DESC LIMIT 50`,
        [appId],
      );
      return history.rows;
    },

    async get(appId, id) {
      const rule = await db.query<{ name: string; webhook_enc: Buffer }>(
        'SELECT name, webhook_enc FROM alert_rules WHERE app_id = $1 AND id = $2',
        [appId, id],
      );
      const row = rule.rows[0];
      return row && { name: row.name, webhook: row.webhook_enc };
    },

    async create(appId, rule) {
      const res = await db.query<{ id: string }>(
        `INSERT INTO alert_rules (app_id, name, metric, comparator, threshold, window_s, webhook_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
        [appId, rule.name, rule.metric, rule.comparator, rule.threshold, rule.windowS, rule.webhook],
      );
      return res.rows[0]!.id;
    },

    async setEnabled(appId, id, enabled) {
      const res = await db.query('UPDATE alert_rules SET enabled = $3 WHERE app_id = $1 AND id = $2', [
        appId,
        id,
        enabled,
      ]);
      return Boolean(res.rowCount);
    },

    async delete(appId, id) {
      const res = await db.query('DELETE FROM alert_rules WHERE app_id = $1 AND id = $2', [appId, id]);
      return Boolean(res.rowCount);
    },

    async active() {
      const rules = await db.query<Omit<RuleRow, 'enabled'>>(
        'SELECT id, app_id, name, metric, comparator, threshold, window_s, webhook_enc, last_fired FROM alert_rules WHERE enabled',
      );
      return rules.rows.map((r) => ({
        id: r.id,
        appId: r.app_id,
        name: r.name,
        metric: r.metric,
        comparator: r.comparator,
        threshold: r.threshold,
        windowS: r.window_s,
        webhook: r.webhook_enc,
        lastFired: r.last_fired,
      }));
    },

    metricValue: (appId, metric, windowS) => evaluateMetric(db, appId, metric, windowS),

    async recordFiring(rule, at, value, delivered, error) {
      await db.query('UPDATE alert_rules SET last_fired = $2 WHERE id = $1', [rule.id, at]);
      await db.query(
        'INSERT INTO alert_events (rule_id, app_id, ts, value, delivered, error) VALUES ($1, $2, $3, $4, $5, $6)',
        [rule.id, rule.appId, at, value, delivered, error],
      );
    },
  };
}
