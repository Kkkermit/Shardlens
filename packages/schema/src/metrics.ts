/**
 * Stable metric identifiers. Rollup tables and the query API use these names, and the docs site renders its metrics
 * table from this registry. Renaming a metric is a breaking change.
 */

export type MetricKind = 'counter' | 'gauge';
export type MetricUnit = 'count' | 'ms' | 'bytes' | 'servers' | 'users' | 'sessions';

export interface MetricDefinition {
  /** Stable identifier. Names ending in `.<name>` or `.<type>` are patterns. */
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit: MetricUnit;
  /** Wire event type(s) the metric is derived from. */
  readonly source: readonly string[];
  readonly description: string;
  /** True when one row exists per shard. */
  readonly perShard?: boolean;
}

export const METRICS = [
  {
    name: 'interactions',
    kind: 'counter',
    unit: 'count',
    source: ['interaction', 'message_command'],
    description:
      'Commands, context menus, entry points and message (prefix) commands run, with outcome and response-time histogram. Split by command, subcommand, kind, outcome, context, install type, locale and member tier; never by server.',
  },
  {
    name: 'interactions.by_guild',
    kind: 'counter',
    unit: 'count',
    source: ['interaction', 'message_command'],
    description:
      'The same runs split by server, kind, command and outcome only, so the main rollup does not grow with commands × servers.',
  },
  {
    name: 'interactions.autocomplete',
    kind: 'counter',
    unit: 'count',
    source: ['interaction'],
    description: 'Autocomplete requests, by command and focused option.',
  },
  {
    name: 'components',
    kind: 'counter',
    unit: 'count',
    source: ['interaction'],
    description: 'Button and select-menu interactions, by normalised custom ID and source command.',
  },
  {
    name: 'interactions.errors',
    kind: 'counter',
    unit: 'count',
    source: ['interaction_error'],
    description: 'Wrapped handlers that failed after the first response, by command and error class.',
  },
  {
    name: 'commands.permissions',
    kind: 'counter',
    unit: 'count',
    source: ['command_permissions'],
    description: 'Servers changing who may use commands (command lockdowns).',
  },
  {
    name: 'modals.shown',
    kind: 'counter',
    unit: 'count',
    source: ['interaction'],
    description: 'Interaction callbacks of type 9 (modal shown), by command.',
  },
  {
    name: 'modals.submitted',
    kind: 'counter',
    unit: 'count',
    source: ['interaction'],
    description: 'Modal submissions, by normalised custom ID.',
  },
  {
    name: 'rest.calls',
    kind: 'counter',
    unit: 'count',
    source: ['rest_window'],
    description: 'REST calls by bucketed route, method and status, with a latency histogram.',
  },
  {
    name: 'rest.invalid',
    kind: 'counter',
    unit: 'count',
    source: ['rest_window', 'invalid_request_warning'],
    description: '401, 403 and non-shared 429 responses, counted against the 10,000 per 10 minutes ban threshold.',
  },
  {
    name: 'rest.ratelimits',
    kind: 'counter',
    unit: 'count',
    source: ['rate_limit'],
    description: '429 responses by scope (user, global, shared) and route.',
  },
  {
    name: 'guild.joins',
    kind: 'counter',
    unit: 'servers',
    source: ['guild_join', 'guild_snapshot'],
    description: 'Servers that added the bot, including joins detected at startup.',
  },
  {
    name: 'guild.leaves',
    kind: 'counter',
    unit: 'servers',
    source: ['guild_leave', 'guild_snapshot'],
    description: 'Servers that removed the bot, including removals detected at startup.',
  },
  {
    name: 'guild.unavailable',
    kind: 'counter',
    unit: 'servers',
    source: ['guild_availability'],
    description: 'Server outages reported by Discord (kept apart from removals).',
  },
  {
    name: 'shard.events',
    kind: 'counter',
    unit: 'count',
    source: ['shard_state'],
    description: 'Shard lifecycle events: ready, resumed, reconnecting, disconnected, error, invalidated.',
  },
  {
    name: 'entitlements',
    kind: 'counter',
    unit: 'count',
    source: ['entitlement'],
    description: 'Entitlements created, updated and deleted, by SKU.',
  },
  {
    name: 'subscriptions',
    kind: 'counter',
    unit: 'count',
    source: ['subscription'],
    description: 'Subscriptions created, updated and deleted, by SKU and status.',
  },
  {
    name: 'custom.<name>',
    kind: 'counter',
    unit: 'count',
    source: ['custom'],
    description: 'Custom events sent with `track()`, one metric per event name.',
  },
  {
    name: 'webhook.<type>',
    kind: 'counter',
    unit: 'count',
    source: ['webhook'],
    description: 'Discord webhook events received by the collector, one metric per event type.',
  },

  {
    name: 'shard.ping_ms',
    kind: 'gauge',
    unit: 'ms',
    source: ['gauge_window'],
    description: 'Gateway heartbeat latency, sampled every 30 seconds.',
    perShard: true,
  },
  {
    name: 'shard.guilds',
    kind: 'gauge',
    unit: 'servers',
    source: ['gauge_window'],
    description: 'Servers on the shard. The total server count is the sum of the latest value per shard.',
    perShard: true,
  },
  {
    name: 'eventloop.p99_ms',
    kind: 'gauge',
    unit: 'ms',
    source: ['gauge_window'],
    description: 'Event-loop delay p99 in the bot process over the last sample window.',
  },
  {
    name: 'memory.rss_bytes',
    kind: 'gauge',
    unit: 'bytes',
    source: ['gauge_window'],
    description: 'Resident set size of the bot process.',
  },
  {
    name: 'memory.heap_used_bytes',
    kind: 'gauge',
    unit: 'bytes',
    source: ['gauge_window'],
    description: 'V8 heap in use in the bot process.',
  },
  {
    name: 'cache.users',
    kind: 'gauge',
    unit: 'count',
    source: ['gauge_window'],
    description: 'Size of the discord.js user cache.',
  },
  {
    name: 'cache.channels',
    kind: 'gauge',
    unit: 'count',
    source: ['gauge_window'],
    description: 'Size of the discord.js channel cache.',
  },
  {
    name: 'identify.remaining',
    kind: 'gauge',
    unit: 'sessions',
    source: ['app_info'],
    description: 'Remaining identify calls in the current 24-hour window (`session_start_limit.remaining`).',
  },
  {
    name: 'app.approx_guilds',
    kind: 'gauge',
    unit: 'servers',
    source: ['app_info'],
    description: "Discord's approximate server count for the application.",
  },
  {
    name: 'app.approx_user_installs',
    kind: 'gauge',
    unit: 'users',
    source: ['app_info'],
    description: "Discord's approximate user-install count for the application.",
  },
] as const satisfies readonly MetricDefinition[];

export type MetricName = (typeof METRICS)[number]['name'];

/** Gauge names the SDK may send in a `gauge_window`. */
export const GAUGE_NAMES: readonly string[] = METRICS.filter((m) => m.kind === 'gauge').map((m) => m.name);
