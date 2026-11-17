import { type ActivityLogFilters, type ActivityLogPage, type ActivityTopUsers, activityLogPath } from './activity.js';
import { liveUpdates } from './live.js';
import type {
  AudienceResult,
  BurstsResult,
  CommandResult,
  CommandsResult,
  EventPropKeys,
  EventPropsResult,
  EventPropValues,
  EventsResult,
  FunnelResult,
  GaugeResult,
  GrowthResult,
  HeatmapResult,
  InstallsResult,
  LiveUpdate,
  Meta,
  OverviewResult,
  PremiumResult,
  QueryResults,
  ReliabilityResult,
  RetentionResult,
  SeriesResult,
  ServerResult,
  ServersResult,
  TopResult,
} from './results.js';
import type {
  AudienceQuery,
  BurstsQuery,
  CommandQuery,
  CommandsQuery,
  EventPropsQuery,
  EventsQuery,
  FunnelQuery,
  GaugeQuery,
  GrowthQuery,
  HeatmapQuery,
  InstallsQuery,
  PremiumQuery,
  QuerySpec,
  ReliabilityQuery,
  RetentionQuery,
  SeriesQuery,
  ServersQuery,
  TopQuery,
} from './specs.js';
import { createTransport, type RequestOptions, type ShardlensClientOptions } from './transport.js';

/**
 * Who ran what, from a collector in audit mode. Needs an activity key (`slk_activity_…`): with a read key these
 * reject with `activity_key_required`, and with `audit_mode_off` when the collector hashes users instead.
 */
export interface ShardlensActivity {
  /** One page of the activity log, newest first. Pass a page's `nextBefore` as `before` for the page after it. */
  log(filters?: ActivityLogFilters, options?: RequestOptions): Promise<ActivityLogPage>;
  /** The users who ran the most in the last 24 hours (the default) or 7 days. */
  topUsers(window?: '24h' | '7d', options?: RequestOptions): Promise<ActivityTopUsers>;
}

/** Reads one collector. Every method rejects with a {@link ShardlensClientError} when it can't get an answer. */
export interface ShardlensClient {
  /** Runs any query. The answer's type follows the spec's `kind`. */
  query<S extends QuerySpec>(spec: S, options?: RequestOptions): Promise<QueryResults[S['kind']]>;
  /** The bot at a glance: the last 30 days of runs, servers, users, and whether events are arriving. */
  overview(options?: RequestOptions): Promise<OverviewResult>;
  /** Every command that ran or is registered, compared with the period before. */
  commands(spec: Omit<CommandsQuery, 'kind'>, options?: RequestOptions): Promise<CommandsResult>;
  /** One command in depth: outcomes, subcommands, options, where and by whom it runs. */
  command(name: string, spec: Omit<CommandQuery, 'kind' | 'name'>, options?: RequestOptions): Promise<CommandResult>;
  /** A metric over time, optionally split by one dimension. */
  series(spec: Omit<SeriesQuery, 'kind'>, options?: RequestOptions): Promise<SeriesResult>;
  /** The busiest values of one dimension: top commands, top servers, top routes. */
  top(spec: Omit<TopQuery, 'kind'>, options?: RequestOptions): Promise<TopResult>;
  /** Counts by weekday and hour of the day. */
  heatmap(spec: Omit<HeatmapQuery, 'kind'>, options?: RequestOptions): Promise<HeatmapResult>;
  /** The servers the bot is or was in, filtered and sorted, one page at a time. */
  servers(spec?: Omit<ServersQuery, 'kind'>, options?: RequestOptions): Promise<ServersResult>;
  /** One server's profile and history. `found` is `false` for a server the collector has never seen. */
  server(guild: string, options?: RequestOptions): Promise<ServerResult>;
  /** Servers joined and left, activation, cohorts and how long servers stay. */
  growth(spec: Omit<GrowthQuery, 'kind'>, options?: RequestOptions): Promise<GrowthResult>;
  /** Unique users per day, week and salt period, and how runs split by locale, install, context and member tier. */
  audience(spec: Omit<AudienceQuery, 'kind'>, options?: RequestOptions): Promise<AudienceResult>;
  /** Missed deadlines, errors, REST calls, rate limits, shards and the SDK's own health. */
  reliability(spec: Omit<ReliabilityQuery, 'kind'>, options?: RequestOptions): Promise<ReliabilityResult>;
  /** A gauge over time, such as `shard.ping_ms` or `memory.rss_bytes`. */
  gauge(spec: Omit<GaugeQuery, 'kind'>, options?: RequestOptions): Promise<GaugeResult>;
  /** Minutes with far more runs than the median minute. */
  bursts(spec: Omit<BurstsQuery, 'kind'>, options?: RequestOptions): Promise<BurstsResult>;
  /** Entitlements and subscriptions by SKU, and the premium share of runs. */
  premium(spec: Omit<PremiumQuery, 'kind'>, options?: RequestOptions): Promise<PremiumResult>;
  /** User installs and removals, from Discord's webhook events. */
  installs(spec: Omit<InstallsQuery, 'kind'>, options?: RequestOptions): Promise<InstallsResult>;
  /** The custom events sent with `track()`. */
  events(spec: Omit<EventsQuery, 'kind'>, options?: RequestOptions): Promise<EventsResult>;
  /** One custom event's property names or, with `prop`, the most common values of that property. */
  eventProps(
    spec: Omit<EventPropsQuery, 'kind' | 'prop'> & { prop: string },
    options?: RequestOptions,
  ): Promise<EventPropValues>;
  eventProps(
    spec: Omit<EventPropsQuery, 'kind' | 'prop'> & { prop?: undefined },
    options?: RequestOptions,
  ): Promise<EventPropKeys>;
  eventProps(spec: Omit<EventPropsQuery, 'kind'>, options?: RequestOptions): Promise<EventPropsResult>;
  /** How many people got through 2 to 5 steps (custom events or commands), in order. */
  funnel(spec: Omit<FunnelQuery, 'kind'>, options?: RequestOptions): Promise<FunnelResult>;
  /** People who did one thing, by when they first did, and how many came back in each later period. */
  retention(spec: Omit<RetentionQuery, 'kind'>, options?: RequestOptions): Promise<RetentionResult>;
  /** The app and how its collector is set up: mode, salt period, time zone, retention. */
  meta(options?: RequestOptions): Promise<Meta>;
  /**
   * What the bot is doing right now, about once a second, over Server-Sent Events. The connection opens when
   * iteration starts and is closed when it ends: on the signal, on leaving the loop, or when the collector closes the
   * stream (a restart, a proxy's time limit). Call `live()` again to reconnect.
   */
  live(options?: RequestOptions): AsyncIterable<LiveUpdate>;
  /** Who ran what: the activity log of a collector in audit mode. */
  readonly activity: ShardlensActivity;
}

/**
 * A client for one collector. Making one never throws and sends nothing: with a `url` or `key` it can't use, every
 * call rejects with a {@link ShardlensClientError} (`invalid_options`) saying why.
 */
export function createShardlensClient(options: ShardlensClientOptions): ShardlensClient {
  const transport = createTransport(options);
  const run = <S extends QuerySpec>(spec: S, options?: RequestOptions) =>
    transport.request<QueryResults[S['kind']]>('/v1/query', { body: spec, signal: options?.signal });
  const get = <T>(path: string, options?: RequestOptions) => transport.request<T>(path, { signal: options?.signal });

  return {
    query: run,
    overview: (options) => run({ kind: 'overview' }, options),
    commands: (spec, options) => run({ ...spec, kind: 'commands' }, options),
    command: (name, spec, options) => run({ ...spec, kind: 'command', name }, options),
    series: (spec, options) => run({ ...spec, kind: 'series' }, options),
    top: (spec, options) => run({ ...spec, kind: 'top' }, options),
    heatmap: (spec, options) => run({ ...spec, kind: 'heatmap' }, options),
    servers: (spec, options) => run({ ...spec, kind: 'servers' }, options),
    server: (guild, options) => run({ kind: 'server', guild }, options),
    growth: (spec, options) => run({ ...spec, kind: 'growth' }, options),
    audience: (spec, options) => run({ ...spec, kind: 'audience' }, options),
    reliability: (spec, options) => run({ ...spec, kind: 'reliability' }, options),
    gauge: (spec, options) => run({ ...spec, kind: 'gauge' }, options),
    bursts: (spec, options) => run({ ...spec, kind: 'bursts' }, options),
    premium: (spec, options) => run({ ...spec, kind: 'premium' }, options),
    installs: (spec, options) => run({ ...spec, kind: 'installs' }, options),
    events: (spec, options) => run({ ...spec, kind: 'events' }, options),
    // One request serves all three overloads: the collector answers by whether `prop` is there.
    eventProps: ((spec: Omit<EventPropsQuery, 'kind'>, options?: RequestOptions) =>
      run({ ...spec, kind: 'eventProps' }, options)) as ShardlensClient['eventProps'],
    funnel: (spec, options) => run({ ...spec, kind: 'funnel' }, options),
    retention: (spec, options) => run({ ...spec, kind: 'retention' }, options),
    meta: (options) => get('/v1/meta', options),
    live: (options) => liveUpdates(transport, options?.signal),
    activity: {
      log: (filters = {}, options) => get(activityLogPath(filters), options),
      topUsers: (window = '24h', options) => get(`/v1/audit/top-users?window=${encodeURIComponent(window)}`, options),
    },
  };
}
