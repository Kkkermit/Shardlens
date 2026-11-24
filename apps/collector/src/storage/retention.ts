/**
 * How long each kind of data is kept, in days, by the PostgreSQL table that holds it: `raw` follows the app's raw
 * retention setting, `audit` its audit retention setting. Ingest refuses events older than their kind is kept.
 */
export const RETENTION_DAYS = {
  interactions: 'raw',
  interaction_errors: 'raw',
  rest_calls: 'raw',
  rest_invalid: 'raw',
  rate_limits: 'raw',
  custom_events: 'raw',
  webhook_events: 'raw',
  gauges: 30,
  audit_log: 'audit',
  rollup_1m: 14,
} as const satisfies Record<string, number | 'raw' | 'audit'>;

/** Default raw retention, and the most days of raw history ingest will ever accept. */
export const ACCEPT_BACK_DAYS = 35;
