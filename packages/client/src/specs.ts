/**
 * A time span. Both ends are ISO 8601 date-times with an offset (`2026-11-01T00:00:00Z`), `from` before `to`, at most
 * 400 days apart. {@link lastDays} makes one.
 */
export interface TimeRange {
  from: string;
  to: string;
}

/** What a `series`, `top` or `heatmap` query counts. `custom` is a custom event, named by the query's `name`. */
export type SeriesMetric =
  | 'interactions'
  | 'interactions.autocomplete'
  | 'components'
  | 'modals.submitted'
  | 'modals.shown'
  | 'interactions.errors'
  | 'rest.calls'
  | 'rest.invalid'
  | 'rest.ratelimits'
  | 'guild.joins'
  | 'guild.leaves'
  | 'guild.unavailable'
  | 'custom';

/**
 * What a query can group or filter by. Each metric keeps only some of these, and the collector answers
 * `invalid_query`, naming the ones it keeps, when asked for another. There is no user dimension.
 */
export type Dimension =
  | 'command'
  | 'sub'
  | 'kind'
  | 'outcome'
  | 'context'
  | 'install'
  | 'guild'
  | 'locale'
  | 'tier'
  | 'custom_id'
  | 'source'
  | 'option'
  | 'error_class'
  | 'method'
  | 'route'
  | 'status'
  | 'scope'
  | 'detected';

/** Keeps the rows whose `field` is `value`, or one of up to 100 values with `op: 'in'` or an array. */
export interface Filter {
  field: Dimension;
  /** Default `'eq'`. */
  op?: 'eq' | 'in' | undefined;
  value: string | readonly string[];
}

/** How a metric's rows are combined. The percentiles are of response time, in milliseconds. Default `'count'`. */
export type Stat = 'count' | 'sum' | 'avg' | 'p50' | 'p95' | 'p99';

/** One step of a funnel or a cohort: a custom event or a command, by name. */
export type Step = { type: 'event'; name: string } | { type: 'command'; name: string };

/** A metric over time, optionally split by one dimension. */
export interface SeriesQuery {
  kind: 'series';
  metric: SeriesMetric;
  /** For `metric: 'custom'`: the event's name. */
  name?: string | undefined;
  range: TimeRange;
  /** Minute series cover 2 days at most, hourly series 31. */
  interval: 'minute' | 'hour' | 'day' | 'week' | 'month';
  groupBy?: Dimension | undefined;
  stat?: Stat | undefined;
  /** Up to 10. */
  filters?: readonly Filter[] | undefined;
  /** IANA name the points are cut in. Default `'UTC'`. */
  timezone?: string | undefined;
  /** With `groupBy`: how many of its values to keep, the busiest first. 1 to 20, default 10. */
  limit?: number | undefined;
}

/** The busiest values of one dimension. */
export interface TopQuery {
  kind: 'top';
  metric: SeriesMetric;
  /** For `metric: 'custom'`: the event's name. */
  name?: string | undefined;
  range: TimeRange;
  groupBy: Dimension;
  stat?: Stat | undefined;
  /** Up to 10. */
  filters?: readonly Filter[] | undefined;
  /** 1 to 500, default 20. */
  limit?: number | undefined;
}

/** Counts by weekday and hour of the day. */
export interface HeatmapQuery {
  kind: 'heatmap';
  /** Default `'interactions'`. */
  metric?: SeriesMetric | undefined;
  range: TimeRange;
  /** Up to 10. */
  filters?: readonly Filter[] | undefined;
  /** IANA name the weekdays and hours are in. Default `'UTC'`. */
  timezone?: string | undefined;
}

/** Every command that ran or is registered, compared with the period before. */
export interface CommandsQuery {
  kind: 'commands';
  range: TimeRange;
  extra?: string | undefined;
}

/** One command in depth. */
export interface CommandQuery {
  kind: 'command';
  /** The command's name, without the slash. */
  name: string;
  range: TimeRange;
}

/** The servers the bot is or was in, one page at a time. */
export interface ServersQuery {
  kind: 'servers';
  /** Part of a server's name. */
  search?: string | undefined;
  /** Default `'active'`: servers the bot is in now. */
  status?: 'active' | 'left' | 'all' | undefined;
  /** A Discord server feature, such as `COMMUNITY`. */
  feature?: string | undefined;
  /** The server's preferred locale, such as `en-GB`. */
  locale?: string | undefined;
  /** Member count. */
  size?: '1-10' | '11-100' | '101-1k' | '1k-10k' | '10k+' | undefined;
  /** Only servers with no command in the last 30 days. */
  inactive?: boolean | undefined;
  /** Only servers where the bot lacks a permission that Settings lists as required. */
  missingPermissions?: boolean | undefined;
  /** Default `'members'`. */
  sort?: 'members' | 'joined' | 'last_active' | 'runs' | 'name' | undefined;
  /** Default `'desc'`. */
  order?: 'asc' | 'desc' | undefined;
  /** 1 to 200, default 50. */
  limit?: number | undefined;
  /** Rows to skip. Default 0. */
  offset?: number | undefined;
}

/** One server's profile and history. */
export interface ServerQuery {
  kind: 'server';
  /** The server's ID. */
  guild: string;
}

/** Servers joined and left, activation, cohorts and how long servers stay. */
export interface GrowthQuery {
  kind: 'growth';
  range: TimeRange;
  /** IANA name the days are cut in. Default `'UTC'`. */
  timezone?: string | undefined;
}

/** Unique users per day, week and salt period, and how runs split by locale, install, context and member tier. */
export interface AudienceQuery {
  kind: 'audience';
  range: TimeRange;
}

/** The bot at a glance: the last 30 days of runs, servers, users, and whether events are arriving. */
export interface OverviewQuery {
  kind: 'overview';
}

/** A gauge over time, such as `shard.ping_ms`, `shard.guilds` or `memory.rss_bytes`. */
export interface GaugeQuery {
  kind: 'gauge';
  name: string;
  range: TimeRange;
  /** Minute series cover 2 days at most. */
  interval: 'minute' | 'hour' | 'day';
  /** One line per shard instead of one for the bot. Default `false`. */
  perShard?: boolean | undefined;
  /** IANA name the points are cut in. Default `'UTC'`. */
  timezone?: string | undefined;
}

/** Minutes in the last 14 days with far more runs than the median minute. */
export interface BurstsQuery {
  kind: 'bursts';
  range: TimeRange;
  /** How many times the median counts as a burst. 2 to 50, default 5. */
  factor?: number | undefined;
}

/** Missed deadlines, errors, REST calls, rate limits, shards and the SDK's own health. */
export interface ReliabilityQuery {
  kind: 'reliability';
  range: TimeRange;
}

/** Entitlements and subscriptions by SKU, and the premium share of runs. */
export interface PremiumQuery {
  kind: 'premium';
  range: TimeRange;
}

/** User installs and removals, from Discord's webhook events. */
export interface InstallsQuery {
  kind: 'installs';
  range: TimeRange;
  /** IANA name the days are cut in. Default `'UTC'`. */
  timezone?: string | undefined;
}

/** The custom events sent with `track()`. */
export interface EventsQuery {
  kind: 'events';
  range: TimeRange;
}

/** One custom event's property names or, with `prop`, the most common values of that property. */
export interface EventPropsQuery {
  kind: 'eventProps';
  /** The custom event's name. */
  name: string;
  range: TimeRange;
  prop?: string | undefined;
}

/** How many people got through 2 to 5 steps, in order. */
export interface FunnelQuery {
  kind: 'funnel';
  steps: readonly Step[];
  range: TimeRange;
  /** Every step must happen within this many hours of the first. 1 to 168, default 24. */
  windowHours?: number | undefined;
  /** IANA name the daily cohorts are cut in. Default `'UTC'`. */
  timezone?: string | undefined;
}

/** People who did `start`, by the day or week they first did, and how many came back in each later period. */
export interface RetentionQuery {
  kind: 'retention';
  start: Step;
  /** What counts as coming back. Default `'any'`: any command or custom event. */
  return?: Step | 'any' | undefined;
  range: TimeRange;
  /** Default `'week'`. */
  interval?: 'day' | 'week' | undefined;
  /** IANA name the cohorts are cut in. Default `'UTC'`. */
  timezone?: string | undefined;
}

/** Any query the collector's `POST /v1/query` accepts, told apart by `kind`. */
export type QuerySpec =
  | SeriesQuery
  | TopQuery
  | HeatmapQuery
  | CommandsQuery
  | CommandQuery
  | ServersQuery
  | ServerQuery
  | GrowthQuery
  | AudienceQuery
  | OverviewQuery
  | GaugeQuery
  | BurstsQuery
  | ReliabilityQuery
  | PremiumQuery
  | InstallsQuery
  | EventsQuery
  | EventPropsQuery
  | FunnelQuery
  | RetentionQuery;
