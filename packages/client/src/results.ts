/*
 * What the collector answers to each query. Times are ISO 8601 strings unless a field says otherwise; days, weeks and
 * salt periods are `YYYY-MM-DD`. Counts can be fractions when the bot samples events.
 */

/** One value of a dimension and how often it occurred. */
export interface KeyCount {
  key: string;
  value: number;
}

/** As {@link KeyCount}, for a dimension an event may not have: `key` is `null` for the events without it. */
export interface NullableKeyCount {
  key: string | null;
  value: number;
}

/** One process of the bot, as the SDK last reported on itself. */
export interface SdkInstance {
  instance: string;
  /** When it last reported. */
  ts: string;
  /** The shards the process holds. */
  shards: number[];
  /** Events waiting to be sent. */
  queueDepth: number;
  /** Events the SDK gave up on, by reason. */
  dropped: Record<string, number>;
  failedFlushes: number;
  /** Errors caught inside the SDK, by where they happened. */
  internalErrors: Record<string, number>;
  sdkVersion: string | null;
}

/** Answer to a `series` query. */
export interface SeriesResult {
  /** The time zone the points are cut in. */
  timezone: string;
  /** Set when a ClickHouse analytics store answered instead of PostgreSQL. */
  source?: 'clickhouse';
  points: {
    /** Start of the interval in `timezone`, without an offset: `2026-11-16T00:00:00`. */
    t: string;
    /** The `groupBy` value (`''` for events without it), or `null` when the query has no `groupBy`. */
    key: string | null;
    /** `null` when the statistic has nothing to work from, such as a percentile of runs that never answered. */
    value: number | null;
  }[];
}

/** Answer to a `top` query. */
export interface TopResult {
  rows: {
    /** The `groupBy` value; `''` for events without it. */
    key: string;
    /** The asked `stat`. */
    value: number | null;
    /** How many events the row covers, whatever the `stat`. */
    count: number;
    /** With `groupBy: 'guild'` only: the server's name, `null` when the collector has no profile for it. */
    name?: string | null;
    /** With `groupBy: 'guild'` only: the server's icon hash. */
    icon?: string | null;
  }[];
}

/** Answer to a `heatmap` query. */
export interface HeatmapResult {
  /** The time zone the weekdays and hours are in. */
  timezone: string;
  /** Set when a ClickHouse analytics store answered instead of PostgreSQL. */
  source?: 'clickhouse';
  /** Only the cells that have something in them. */
  cells: {
    /** ISO weekday: 1 is Monday, 7 is Sunday. */
    weekday: number;
    /** 0 to 23. */
    hour: number;
    value: number;
  }[];
}

/** One command in the answer to a `commands` query. */
export interface CommandRow {
  command: string;
  runs: number;
  /** Runs in the period of the same length just before the range. */
  previousRuns: number;
  /** Change against `previousRuns`, in percent. `null` when there were none. */
  changePct: number | null;
  /** Share of runs that did not end `ok`, 0 to 1. `null` without runs. */
  errorRate: number | null;
  /** 95th percentile of the time to the first response, in milliseconds. */
  p95Ms: number | null;
  /** Servers the command ran in. */
  servers: number;
  /** Start of the last hour (or day, in ranges that reach back more than 13 months) the command ran in. */
  lastUsed: string | null;
  /** Unique users since `periodStart`. `null` until the hourly count has run. */
  uniqueUsersThisPeriod: number | null;
  /** Whether the bot has the command registered with Discord. `false` for prefix commands and removed commands. */
  registered: boolean;
  /** How the command ran or is registered: `chat_input`, `message_command` (prefix), `user_context`… */
  kinds: string[];
}

/** Answer to a `commands` query: up to 500 commands, the most used first. */
export interface CommandsResult {
  /** First day of the current salt period, which `uniqueUsersThisPeriod` counts from. */
  periodStart: string;
  rows: CommandRow[];
}

/** Answer to a `command` query. Read from single events, which the collector keeps for 7 to 90 days. */
export interface CommandResult {
  /** Where counting starts: the range's `from`, or later when single events are no longer kept that far back. */
  from: string;
  /** Every figure is `null` when the command did not run in the range. */
  totals: {
    runs: number | null;
    ok: number | null;
    error: number | null;
    /** Runs whose first response missed Discord's 3-second deadline. */
    timeout: number | null;
    noResponse: number | null;
    /** Share of runs answered with a deferral, 0 to 1. Prefix commands, which have no response, don't count. */
    deferRate: number | null;
    /** Share of runs answered ephemerally, 0 to 1. */
    ephemeralRate: number | null;
    /** Share of runs by users with an entitlement, 0 to 1. */
    premiumShare: number | null;
    /** Share of answered runs whose first response took more than 3 seconds. */
    over3sRate: number | null;
    /** 95th percentile of the handler's run time, in milliseconds. */
    handlerP95Ms: number | null;
    firstSeen: string | null;
    lastSeen: string | null;
  };
  /**
   * Time to the first response in 40 buckets on a log scale: bucket `i` ends at `60000 ** ((i + 1) / 39)`
   * milliseconds. `null` when no run answered.
   */
  latencyHistogram: number[] | null;
  kinds: KeyCount[];
  /** Subcommands, with their group in front (`config set`). */
  subcommands: KeyCount[];
  /** Option names, by how many runs used them. */
  options: KeyCount[];
  /** Values of the options the bot lists in `captureOptionValues`. */
  optionValues: { option: string; value: string; runs: number }[];
  /** `admin`, `manager`, `member` or `dm`. */
  memberTiers: NullableKeyCount[];
  /** `guild`, `user` or `both`. */
  installs: NullableKeyCount[];
  /** `0` server, `1` bot DM, `2` private channel. */
  contexts: NullableKeyCount[];
  /** Discord channel type numbers. */
  channelTypes: KeyCount[];
  locales: KeyCount[];
  /** The 10 servers that ran it most. `key` is the server's ID. */
  topServers: { key: string; value: number; name: string | null; icon: string | null }[];
  /** Buttons and select menus on the command's messages, by custom ID. */
  components: { key: string | null; kind: string; value: number }[];
  /** Modals the command opened, and how many were submitted. */
  modals: { customId: string; shown: number; submitted: number }[];
}

/** One server in the answer to a `servers` query. */
export interface ServerRow {
  id: string;
  /** Text chosen by the server's owner: render it as text. */
  name: string;
  /** Discord's icon hash. */
  icon: string | null;
  memberCount: number;
  boosts: number | null;
  premiumTier: number | null;
  locale: string | null;
  features: string[];
  joinedAt: string;
  leftAt: string | null;
  shard: number | null;
  /** The last command run in the server. */
  lastActive: string | null;
  /** The bot joined while it was offline, so `joinedAt` is when it noticed. */
  detectedAtStartup: boolean;
  /** The bot was already in the server when Shardlens was installed. */
  baseline: boolean;
  /** Command runs in the last 30 days. */
  runs: number;
}

/** Answer to a `servers` query. */
export interface ServersResult {
  /** Servers matching the filters, on every page. */
  total: number;
  rows: ServerRow[];
}

/** A server's profile, as the bot last saw it. */
export interface ServerProfile {
  id: string;
  /** Text chosen by the server's owner: render it as text. */
  name: string;
  icon: string | null;
  memberCount: number;
  sizeAtJoin: number | null;
  large: boolean | null;
  locale: string | null;
  features: string[];
  premiumTier: number | null;
  boosts: number | null;
  verificationLevel: number | null;
  nsfwLevel: number | null;
  mfaLevel: number | null;
  createdAt: string | null;
  joinedAt: string;
  leftAt: string | null;
  shard: number | null;
  /** Channels by Discord channel type number. */
  channelCounts: Record<string, number> | null;
  roleCount: number | null;
  emojiCount: number | null;
  stickerCount: number | null;
  /** The bot's permission bits in the server, as a decimal string. */
  botPermissions: string | null;
  detectedAtStartup: boolean;
  baseline: boolean;
  firstCommandAt: string | null;
  lastCommandAt: string | null;
  updatedAt: string;
}

/** Answer to a `server` query. `found` is `false` for a server the collector has never seen. */
export type ServerResult =
  | { found: false }
  | {
      found: true;
      profile: ServerProfile;
      /** The last 100 times the bot joined or left, or the server went down or came back. Newest first. */
      events: { ts: string; kind: 'join' | 'leave' | 'unavailable' | 'available'; detectedAtStartup: boolean }[];
      uniqueUsersThisPeriod: number | null;
      /** First day of the current salt period. */
      periodStart: string;
      /**
       * The permission bits Settings lists as required that the bot lacks here, as a decimal string (`'0'` for none).
       * `null` when no permissions are required or the bot's are unknown.
       */
      missingPermissions: string | null;
    };

/** Answer to a `growth` query. */
export interface GrowthResult {
  /** Days with a join or a leave. The `Detected` figures are those the bot found at startup, having been offline. */
  daily: {
    day: string;
    joins: number | null;
    leaves: number | null;
    joinsDetected: number | null;
    leavesDetected: number | null;
  }[];
  /** Servers that joined in the range, by member count when they did. */
  sizeAtInstall: { bucket: '1-10' | '11-100' | '101-1k' | '1k-10k' | '10k+'; servers: number }[];
  /** Servers that joined in the range, and how many ran a command within 24 hours. */
  activation: { joined: number; activated: number; rate: number | null };
  /** Servers the bot is in now. `inactive` ran no command in the last 30 days. */
  installs: { active: number; inactive: number };
  /** Servers that joined in the same week (`cohort`) and ran a command `week` weeks later. */
  cohorts: { cohort: string; week: number; servers: number }[];
  /** How long the servers that left in the range had stayed. */
  lifetimes: { bucket: '<1d' | '1-7d' | '7-30d' | '30-90d' | '90d+'; servers: number }[];
  /** Discord's own approximate server count, per day. */
  approximateGuilds: { day: string; value: number }[];
  /** The collector's count against Discord's. `warn` when they are more than 2% apart. */
  serverCount: { ours: number; discord: number | null; at: string | null; drift: number | null; warn: boolean };
}

/** Answer to an `audience` query. Users are counted per UTC day, as salted hashes that end with their salt period. */
export interface AudienceResult {
  daily: { day: string; users: number; newUsers: number }[];
  weekly: { week: string; users: number }[];
  /** Unique users per salt period. `final` once the period is over and its count can no longer change. */
  periods: { period: string; users: number; final: boolean }[];
  /** Average daily users over the latest period's users, 0 to 1. */
  stickiness: number | null;
  /** Runs by locale, install type, context and member tier: up to 15 values each. A dimension with no runs is absent. */
  splits: Partial<Record<'locale' | 'install' | 'context' | 'tier', NullableKeyCount[]>>;
  /** Share of runs by users with an entitlement, 0 to 1. */
  premiumShare: number | null;
}

/** Answer to an `overview` query. */
export interface OverviewResult {
  app: {
    id: string;
    name: string;
    mode: 'privacy' | 'audit';
    saltPeriod: 'day' | 'week' | 'month';
    timezone: string;
    rawRetentionDays: number;
  } | null;
  /** What the bot last reported about its application. `null` until it has. */
  appInfo: {
    ts: string;
    name: string;
    approxGuilds: number | null;
    approxUserInstalls: number | null;
    approxUserAuthorizations: number | null;
    /** Discord's webhook events status: 1 disabled, 2 enabled, 3 disabled by Discord. */
    eventWebhooksStatus: number | null;
    sessionStartRemaining: number | null;
    sessionStartTotal: number | null;
    nodeVersion: string | null;
    libVersion: string | null;
    sdkVersion: string | null;
    release: string | null;
  } | null;
  sdkInstances: SdkInstance[];
  /** UTC days with runs in the last 30. */
  runs30d: { day: string; runs: number; failures: number | null }[];
  /** Servers the bot is in now. */
  servers: number;
  uniqueUsersThisPeriod: number | null;
  /** First day of the current salt period. */
  periodStart: string;
  /** Start of the last minute an event arrived in, within the last 14 days. */
  lastEventAt: string | null;
  checklist: {
    receivingEvents: boolean;
    appInfoReceived: boolean;
    webhookEventsEnabled: boolean;
    requiredPermissionsSet: boolean;
  };
}

/** Answer to a `gauge` query. */
export interface GaugeResult {
  /** The time zone the points are cut in. */
  timezone: string;
  points: {
    /** Start of the interval in `timezone`, without an offset: `2026-11-16T00:00:00`. */
    t: string;
    /** The shard, with `perShard`. Otherwise `null`. */
    shard: number | null;
    /** Average over the interval. */
    value: number;
    /** Highest minute in the interval. */
    max: number;
  }[];
}

/** Answer to a `bursts` query: up to 100 minutes, the busiest first. */
export interface BurstsResult {
  rows: { minute: string; runs: number; median: number }[];
}

/** Answer to a `reliability` query. Prefix commands, which have no response or deadline, are left out. */
export interface ReliabilityResult {
  /** Where counting single events starts: the range's `from`, or later when they are no longer kept that far back. */
  from: string;
  /** Every figure is `null` when nothing ran in the range. */
  totals: {
    runs: number | null;
    /** Runs that answered after 3 seconds or not at all. */
    missedDeadlines: number | null;
    noResponse: number | null;
    errors: number | null;
    over3sRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  };
  /** Failed runs by Discord API error code or, without one, by error class. */
  errorsByCode: KeyCount[];
  /** REST calls by method and route. `failures` are answers of 400 and above. */
  routes: {
    method: string;
    route: string;
    calls: number;
    failures: number | null;
    retries: number;
    p95Ms: number | null;
  }[];
  /** Rate limits the bot ran into. `maxRetryAfter` is in milliseconds. */
  rateLimits: { scope: string; route: string; count: number; maxRetryAfter: number | null }[];
  /** 401, 403 and 429 answers in the last 10 minutes, against Discord's limit of 10,000. */
  invalidBudget: { used: number; limit: number; share: number; shared429: number };
  /** Gateway session starts left today, and the versions the bot runs. `null` until the bot has reported them. */
  identify: {
    remaining: number | null;
    total: number | null;
    nodeVersion: string | null;
    libVersion: string | null;
    sdkVersion: string | null;
    release: string | null;
    ts: string;
  } | null;
  /** Each shard's latest ping in the last day. `stale` when it is more than 2 minutes old. */
  shards: { shard: number; ping: number; ts: string; stale: boolean }[];
  /** The last 50 gateway state changes in the range. */
  shardEvents: { ts: string; shard: number; state: string; closeCode: number | null; replayed: number | null }[];
  /** The bot's latest process gauges, added up over its processes (the worst process for event-loop delay). */
  process: Partial<
    Record<
      'eventloop.p99_ms' | 'memory.rss_bytes' | 'memory.heap_used_bytes' | 'cache.users' | 'cache.channels',
      number
    >
  >;
  sdkInstances: SdkInstance[];
}

/** Answer to a `premium` query. */
export interface PremiumResult {
  /** Entitlements created, updated and deleted in the range. `testCount` of them were test entitlements. */
  changes: { sku: string; name: string; action: string; count: number; testCount: number }[];
  activeEntitlements: { sku: string; name: string; active: number }[];
  /** Subscriptions by SKU, with the price set in Settings. */
  subscriptions: {
    sku: string;
    name: string;
    active: number;
    ending: number;
    inactive: number;
    price: { amount: number; currency: string } | null;
  }[];
  /** Share of runs by users with an entitlement, 0 to 1. */
  premiumShare: number | null;
  /** By currency: active and ending subscriptions times their price. */
  estimatedMonthlyRevenue: Record<string, number>;
  pricesConfigured: boolean;
}

/** Answer to an `installs` query. */
export interface InstallsResult {
  daily: { day: string; userInstalls: number; userRemovals: number; serverInstalls: number }[];
  /** OAuth2 scopes granted at install. */
  scopes: { scope: string; installs: number }[];
  /** Discord's own approximate count of user installs, per day. */
  approximateUserInstalls: { day: string; value: number }[];
  /** Discord's webhook events status: 1 disabled, 2 enabled, 3 disabled by Discord. `null` until the bot reports it. */
  webhookStatus: number | null;
}

/** Answer to an `events` query: up to 200 custom events, the most frequent first. */
export interface EventsResult {
  rows: { name: string; count: number; users: number; lastSeen: string }[];
}

/** Answer to an `eventProps` query without `prop`: the event's property names. */
export interface EventPropKeys {
  name: string;
  keys: { key: string; count: number }[];
}

/** Answer to an `eventProps` query with `prop`: that property's 50 most common values, as text. */
export interface EventPropValues {
  name: string;
  prop: string;
  values: { value: string; count: number }[];
}

/** Answer to an `eventProps` query. */
export type EventPropsResult = EventPropKeys | EventPropValues;

/** Answer to a `funnel` query. */
export interface FunnelResult {
  windowHours: number;
  timezone: string;
  /** The steps as asked, with the people who reached each and their median time from the first step. */
  steps: {
    label: string;
    type: 'event' | 'command';
    name: string;
    users: number;
    /** `null` for the first step, and for a step nobody reached. */
    medianSeconds: number | null;
  }[];
  /** People by the day they entered the funnel. `users[i]` reached step `i + 1`. */
  cohorts: { day: string; users: number[] }[];
}

/** Answer to a `retention` query. */
export interface RetentionResult {
  interval: 'day' | 'week';
  timezone: string;
  /** The start step, as a label. */
  start: string;
  /** The return step, as a label. */
  return: string;
  /** Periods followed after the first: 14 days or 8 weeks. */
  periods: number;
  /** `retained[i]` of the `size` people who started in `cohort` came back `i + 1` periods later. */
  cohorts: { cohort: string; size: number; retained: number[] }[];
}

/** The answer each query `kind` gets. */
export interface QueryResults {
  series: SeriesResult;
  top: TopResult;
  heatmap: HeatmapResult;
  commands: CommandsResult;
  command: CommandResult;
  servers: ServersResult;
  server: ServerResult;
  growth: GrowthResult;
  audience: AudienceResult;
  overview: OverviewResult;
  gauge: GaugeResult;
  bursts: BurstsResult;
  reliability: ReliabilityResult;
  premium: PremiumResult;
  installs: InstallsResult;
  events: EventsResult;
  eventProps: EventPropsResult;
  funnel: FunnelResult;
  retention: RetentionResult;
}

/** What `GET /v1/meta` answers: the app and how its collector is set up. */
export interface Meta {
  appId: string;
  name: string;
  /** `audit` when the collector records who ran what. */
  mode: 'privacy' | 'audit';
  saltPeriod: 'day' | 'week' | 'month';
  /** The time zone chosen in Settings, for charts. */
  timezone: string;
  /** How long single events are kept, in days. */
  rawRetentionDays: number;
  auditKeyConfigured: boolean;
  discordLogin: boolean;
  webhookEventsConfigured: boolean;
}

/** One update of the live stream: what the bot is doing right now. */
export interface LiveUpdate {
  ts: string;
  /** Command runs in the last 60 seconds. */
  perMinute: number;
  /** Failed runs in the last 15 minutes. */
  errors15m: number;
  /** Runs in each of the last 60 seconds, oldest first. Empty until the collector has seen a run. */
  perSecond: number[];
  /** 95th percentile of the time to the first response over the last 5 minutes, in milliseconds. */
  p95Ms5m: number | null;
  /** Each shard's latest ping in the last hour. `fresh` when it is under 2 minutes old. */
  shards: { shard: number; ping: number; fresh: boolean }[];
  activeShards: number;
  staleShards: number[];
  /** Servers the bot is in now. */
  servers: number;
}
