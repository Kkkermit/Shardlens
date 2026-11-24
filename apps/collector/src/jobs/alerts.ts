import { postToDiscordWebhook } from '../discord-webhook.js';
import { auditCipher } from '../security/crypto.js';
import type { Store } from '../storage/store.js';

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
  store: Store,
  opts: { settingsKey: string; dashboardUrl: URL | undefined; fetchImpl?: typeof fetch },
  now = new Date(),
): Promise<number> {
  const cipher = auditCipher(opts.settingsKey);
  let fired = 0;
  for (const rule of await store.alerts.active()) {
    if (rule.lastFired && now.getTime() - rule.lastFired.getTime() < ALERT_DEBOUNCE_MS) continue;
    const value = await store.alerts.metricValue(rule.appId, rule.metric, rule.windowS);
    if (value === null || !breaches(value, rule.comparator, rule.threshold)) continue;
    const meta = LABELS[rule.metric] ?? { label: rule.metric, unit: (v: number) => String(v) };
    let url: string;
    try {
      url = cipher.decrypt(rule.webhook);
    } catch {
      // Shown in the alert's history instead of failing silently.
      await store.alerts.recordFiring(rule, now, value, false, UNREADABLE_WEBHOOK);
      continue;
    }
    const minutes = Math.round(rule.windowS / 60);
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
    await store.alerts.recordFiring(rule, now, value, result.ok, result.error ?? null);
    fired++;
  }
  return fired;
}
