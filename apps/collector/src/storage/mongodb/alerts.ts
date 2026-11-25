import { Binary, type Document, ObjectId } from 'mongodb';
import { KIND } from '../../ingest/codes.js';
import type { AlertFiring, AlertRule, AlertStorage } from '../store.js';
import type { AlertRuleDoc } from './collections.js';
import type { Mongo } from './connect.js';
import { ACK_WEIGHTS, ackQuantile } from './histogram.js';
import { compareIds, nextId } from './ids.js';
import { type CountsByWeight, realSumOf } from './query/real-sums.js';

const MINUTE = 60_000;

function toRule(doc: AlertRuleDoc): Omit<AlertRule, 'enabled'> {
  return {
    id: doc._id,
    name: doc.name,
    metric: doc.metric,
    comparator: doc.comparator,
    threshold: doc.threshold,
    windowS: doc.windowS,
    webhook: Buffer.from(doc.webhookEnc.buffer),
    lastFired: doc.lastFired ?? null,
  };
}

/**
 * The metric over the trailing window, read as `storage/postgres/alerts.ts` reads it: same rows, same windows, and
 * `null` in the same cases. Windows end at this process's clock, the clock ingest corrected event times to.
 */
async function evaluateMetric({ c }: Mongo, appId: string, metric: string, windowS: number): Promise<number | null> {
  const now = Date.now();
  const since = new Date(now - windowS * 1000);
  switch (metric) {
    case 'missed_deadline_rate':
    case 'error_rate': {
      const missed = metric === 'missed_deadline_rate';
      const failed: Document = missed ? { $in: ['$outcome', [2, 3]] } : { $ne: ['$outcome', 0] };
      // Message commands have no deadline to miss, so they don't count towards that rate.
      const scope = missed ? { kind: { $ne: KIND.message_command } } : {};
      const runs = await c.interactions
        .aggregate<CountsByWeight<'runs' | 'failed'>>([
          { $match: { appId, ts: { $gt: since }, ...scope } },
          { $group: { _id: '$weight', runs: { $sum: 1 }, failed: { $sum: { $cond: [failed, 1, 0] } } } },
        ])
        .toArray();
      // PostgreSQL's `sum(weight) FILTER (...)` is NULL, not 0, when no row failed: no value, so no rule fires.
      const failures = realSumOf(runs, 'failed');
      const total = realSumOf(runs, 'runs');
      return failures === null || !total ? null : (100 * failures) / total;
    }
    case 'p95_ms': {
      const rows = await c.interactions
        .aggregate<{ _id: number; w: number }>([{ $match: { appId, ts: { $gt: since } } }, ...ACK_WEIGHTS])
        .toArray();
      return ackQuantile(rows, 0.95);
    }
    case 'invalid_requests_pct': {
      // Discord's ban threshold counts the last 10 minutes regardless of the rule's window.
      const [g] = await c.restInvalid
        .aggregate<{ n: number }>([
          { $match: { appId, ts: { $gt: new Date(now - 10 * MINUTE) } } },
          { $group: { _id: null, n: { $sum: { $add: ['$count401', '$count403', '$count429'] } } } },
        ])
        .toArray();
      return g ? (100 * g.n) / 10_000 : 0;
    }
    case 'stale_shards': {
      const [g] = await c.gauges
        .aggregate<{ n: number }>([
          {
            $match: {
              '_id.appId': appId,
              '_id.name': 'shard.ping_ms',
              '_id.ts': { $gt: new Date(now - 1440 * MINUTE) },
            },
          },
          { $group: { _id: '$_id.shard', last: { $max: '$_id.ts' } } },
          { $match: { last: { $lt: since } } },
          { $count: 'n' },
        ])
        .toArray();
      return g?.n ?? 0;
    }
    case 'interactions_per_min': {
      const runs = await c.interactions
        .aggregate<CountsByWeight<'runs'>>([
          { $match: { appId, ts: { $gt: since } } },
          { $group: { _id: '$weight', runs: { $sum: 1 } } },
        ])
        .toArray();
      return (realSumOf(runs, 'runs') ?? 0) / (windowS / 60);
    }
    case 'identify_remaining': {
      const info = await c.appInfo.findOne({ _id: appId }, { projection: { sessionStartRemaining: 1 } });
      return info?.sessionStartRemaining ?? null;
    }
    default:
      return null;
  }
}

export function mongoAlerts(m: Mongo): AlertStorage {
  const { c } = m;
  return {
    async list(appId) {
      const rules = await c.alertRules.find({ appId }).toArray();
      rules.sort((a, b) => compareIds(a._id, b._id));
      return rules.map((r) => ({ ...toRule(r), enabled: r.enabled }));
    },

    async history(appId) {
      // A firing whose rule is gone is left out, as PostgreSQL's join leaves it out.
      return c.alertEvents
        .aggregate<AlertFiring>([
          { $match: { appId } },
          { $sort: { ts: -1, _id: -1 } },
          {
            $lookup: {
              from: c.alertRules.collectionName,
              localField: 'ruleId',
              foreignField: '_id',
              pipeline: [{ $project: { _id: 0, name: 1 } }],
              as: 'rule',
            },
          },
          { $unwind: '$rule' },
          { $limit: 50 },
          {
            $project: {
              _id: 0,
              ts: 1,
              ruleId: 1,
              name: '$rule.name',
              value: 1,
              delivered: 1,
              error: { $ifNull: ['$error', null] },
            },
          },
        ])
        .toArray();
    },

    async get(appId, id) {
      const rule = await c.alertRules.findOne({ _id: id, appId }, { projection: { name: 1, webhookEnc: 1 } });
      return rule ? { name: rule.name, webhook: Buffer.from(rule.webhookEnc.buffer) } : undefined;
    },

    async create(appId, rule) {
      const id = await nextId(c, 'alert_rules');
      await c.alertRules.insertOne({
        _id: id,
        appId,
        name: rule.name,
        metric: rule.metric,
        comparator: rule.comparator,
        threshold: rule.threshold,
        windowS: rule.windowS,
        webhookEnc: new Binary(rule.webhook),
        enabled: true,
      });
      return id;
    },

    async setEnabled(appId, id, enabled) {
      const res = await c.alertRules.updateOne({ _id: id, appId }, { $set: { enabled } });
      return res.matchedCount > 0;
    },

    async delete(appId, id) {
      // History first: if this stops part-way the rule is still there, and deleting it again finishes the job.
      await c.alertEvents.deleteMany({ appId, ruleId: id });
      const res = await c.alertRules.deleteOne({ _id: id, appId });
      return res.deletedCount > 0;
    },

    async active() {
      const rules = await c.alertRules.find({ enabled: true }).toArray();
      rules.sort((a, b) => compareIds(a._id, b._id));
      return rules.map((r) => ({ ...toRule(r), appId: r.appId }));
    },

    metricValue: (appId, metric, windowS) => evaluateMetric(m, appId, metric, windowS),

    async recordFiring(rule, at, value, delivered, error) {
      await c.alertRules.updateOne({ _id: rule.id }, { $set: { lastFired: at } });
      await c.alertEvents.insertOne({
        _id: new ObjectId(),
        ruleId: rule.id,
        appId: rule.appId,
        ts: at,
        value,
        delivered,
        ...(error !== null && { error }),
      });
    },
  };
}
