import type { WireEvent } from './client.js';

/**
 * Receives every event the SDK records, in-process and before sampling. Events never carry a user. Implementations
 * must not label metrics by user or server ID, do I/O in `observe`, or throw.
 */
export interface ShardlensExporter {
  /** Short name, used when counting errors (`exporter:<name>`). */
  readonly name: string;
  observe(event: WireEvent): void;
  shutdown?(): void | Promise<void>;
}

/** One exported instrument. Names are neutral; each exporter applies its own naming convention. */
export interface ExporterMetric {
  readonly kind: 'counter' | 'histogram' | 'gauge';
  readonly description: string;
  readonly unit: 'seconds' | 'bytes' | '1';
  /** Label names. Never a user or server ID. */
  readonly labels: readonly string[];
}

/** Histogram bucket boundaries, in seconds, placed around Discord's 3-second response deadline. */
export const DEFAULT_DURATION_BUCKETS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 30];

/**
 * The instruments every Shardlens exporter registers. Labels are bounded: command names, bucketed REST routes,
 * statuses, shard numbers and custom event names you chose. There is no user or server label anywhere.
 */
export const EXPORTER_METRICS = {
  interactions: {
    kind: 'counter',
    description:
      'Interactions handled (commands, context menus, components, modals, autocomplete) and message (prefix) commands, by outcome.',
    unit: '1',
    labels: ['kind', 'command', 'outcome'],
  },
  interaction_response: {
    kind: 'histogram',
    description: "Time from Discord's interaction timestamp to the first response. Discord's deadline is 3 seconds.",
    unit: 'seconds',
    labels: ['kind', 'command'],
  },
  interaction_handler: {
    kind: 'histogram',
    description: 'Time spent in a handler wrapped with lens.wrap(), or reported for a message command.',
    unit: 'seconds',
    labels: ['kind', 'command'],
  },
  interaction_errors: {
    kind: 'counter',
    description: 'Errors thrown by wrapped handlers, by error class (never the message).',
    unit: '1',
    labels: ['command', 'error_class'],
  },
  rest_requests: {
    kind: 'counter',
    description: 'REST requests to Discord, by method, bucketed route and status.',
    unit: '1',
    labels: ['method', 'route', 'status'],
  },
  rest_invalid_requests: {
    kind: 'counter',
    description: "Responses that count towards Discord's invalid-request limit (10,000 per 10 minutes per IP).",
    unit: '1',
    labels: ['status'],
  },
  ratelimits: {
    kind: 'counter',
    description: 'Requests held back for a rate limit, by scope (user, global or shared).',
    unit: '1',
    labels: ['scope'],
  },
  shard_events: {
    kind: 'counter',
    description: 'Shard state changes (ready, resumed, reconnecting, disconnected, error, invalidated).',
    unit: '1',
    labels: ['shard', 'state'],
  },
  guild_events: {
    kind: 'counter',
    description: 'Servers joined and left, and outages (unavailable, available).',
    unit: '1',
    labels: ['event'],
  },
  custom_events: {
    kind: 'counter',
    description: 'Custom events recorded with track(), by name.',
    unit: '1',
    labels: ['name'],
  },
  entitlements: {
    kind: 'counter',
    description: 'Entitlement changes (create, update, delete).',
    unit: '1',
    labels: ['action'],
  },
  shard_ping: {
    kind: 'gauge',
    description: 'Gateway heartbeat latency per shard.',
    unit: 'seconds',
    labels: ['shard'],
  },
  guilds: { kind: 'gauge', description: 'Servers per shard.', unit: '1', labels: ['shard'] },
  eventloop_delay_p99: {
    kind: 'gauge',
    description: 'Event loop delay, 99th percentile over the last 30 seconds.',
    unit: 'seconds',
    labels: [],
  },
  memory: { kind: 'gauge', description: 'Process memory (rss, heap_used).', unit: 'bytes', labels: ['type'] },
  cache_size: { kind: 'gauge', description: 'discord.js cache sizes (users, channels).', unit: '1', labels: ['cache'] },
  identify_remaining: {
    kind: 'gauge',
    description: "Gateway sessions left in Discord's daily identify budget.",
    unit: '1',
    labels: [],
  },
} as const satisfies Record<string, ExporterMetric>;

export type ExporterMetricName = keyof typeof EXPORTER_METRICS;
export type MetricLabels = Readonly<Record<string, string>>;

/** What an exporter implements to receive translated measurements. */
export interface MetricSink {
  add(metric: ExporterMetricName, labels: MetricLabels, value: number): void;
  record(metric: ExporterMetricName, labels: MetricLabels, value: number): void;
  set(metric: ExporterMetricName, labels: MetricLabels, value: number): void;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** The objects in `v`, if it is an array: a malformed row or gauge is skipped, not thrown on. */
const objects = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];

const GAUGES: Record<string, [ExporterMetricName, (shardOrNothing: string) => MetricLabels, number]> = {
  'shard.ping_ms': ['shard_ping', (shard) => ({ shard }), 1 / 1000],
  'shard.guilds': ['guilds', (shard) => ({ shard }), 1],
  'eventloop.p99_ms': ['eventloop_delay_p99', () => ({}), 1 / 1000],
  'memory.rss_bytes': ['memory', () => ({ type: 'rss' }), 1],
  'memory.heap_used_bytes': ['memory', () => ({ type: 'heap_used' }), 1],
  'cache.users': ['cache_size', () => ({ cache: 'users' }), 1],
  'cache.channels': ['cache_size', () => ({ cache: 'channels' }), 1],
};

/** Turns one wire event into measurements, so every exporter reports the same thing. */
export function translateEvent(event: WireEvent, sink: MetricSink): void {
  const e = event as WireEvent & Record<string, unknown>;
  const weight = num(e.weight) ?? 1;
  switch (e.type) {
    case 'interaction': {
      const kind = str(e.kind, 'unknown');
      const command = str(e.command) || str(e.sourceCommand);
      sink.add('interactions', { kind, command, outcome: str(e.outcome, 'unknown') }, weight);
      // A handler that failed before the row was sent is on the row itself; later failures arrive as `interaction_error`.
      if (e.outcome === 'error' && e.errorClass !== undefined) {
        sink.add('interaction_errors', { command, error_class: str(e.errorClass, 'Error') }, weight);
      }
      const ack = num(e.ackMs);
      if (ack !== undefined) sink.record('interaction_response', { kind, command }, ack / 1000);
      const handler = num(e.handlerMs);
      if (handler !== undefined) sink.record('interaction_handler', { kind, command }, handler / 1000);
      return;
    }
    case 'message_command': {
      const command = str(e.command);
      const labels = { kind: 'message_command', command };
      sink.add('interactions', { ...labels, outcome: str(e.outcome, 'unknown') }, weight);
      if (e.outcome === 'error' && e.errorClass !== undefined) {
        sink.add('interaction_errors', { command, error_class: str(e.errorClass, 'Error') }, weight);
      }
      const handler = num(e.handlerMs);
      if (handler !== undefined) sink.record('interaction_handler', labels, handler / 1000);
      return;
    }
    case 'interaction_error':
      sink.add('interaction_errors', { command: str(e.command), error_class: str(e.errorClass, 'Error') }, weight);
      return;
    case 'rest_window': {
      for (const row of objects(e.rows)) {
        const labels = { method: str(row.method), route: str(row.route), status: String(num(row.status) ?? 0) };
        sink.add('rest_requests', labels, num(row.count) ?? 0);
      }
      const invalid = (e.invalid ?? {}) as Record<string, unknown>;
      for (const [status, key] of [
        ['401', 'count401'],
        ['403', 'count403'],
        ['429', 'count429'],
      ] as const) {
        const n = num(invalid[key]) ?? 0;
        if (n > 0) sink.add('rest_invalid_requests', { status }, n);
      }
      return;
    }
    case 'rate_limit':
      sink.add('ratelimits', { scope: str(e.scope, 'unknown') }, weight);
      return;
    case 'shard_state':
      sink.add('shard_events', { shard: String(num(e.shard) ?? 0), state: str(e.state, 'unknown') }, 1);
      return;
    case 'guild_join':
      sink.add('guild_events', { event: 'join' }, 1);
      return;
    case 'guild_leave':
      sink.add('guild_events', { event: 'leave' }, 1);
      return;
    case 'guild_availability':
      sink.add('guild_events', { event: e.available === true ? 'available' : 'unavailable' }, 1);
      return;
    case 'custom':
      sink.add('custom_events', { name: str(e.name) }, weight);
      return;
    case 'entitlement':
      sink.add('entitlements', { action: str(e.action, 'unknown') }, 1);
      return;
    case 'gauge_window':
      for (const g of objects(e.gauges)) {
        const spec = GAUGES[str(g.name)];
        const value = num(g.value);
        if (!spec || value === undefined) continue;
        const [metric, labels, scale] = spec;
        sink.set(metric, labels(String(num(g.shard) ?? 0)), value * scale);
      }
      return;
    case 'app_info': {
      const remaining = num(e.sessionStartRemaining);
      if (remaining !== undefined) sink.set('identify_remaining', {}, remaining);
      return;
    }
    default:
      return;
  }
}
