/**
 * `@shardlens/client`: a typed client for reading a Shardlens collector from your own dashboard or scripts. Every
 * query the built-in dashboard runs, the live stream and, with an activity key, the activity log. Zero dependencies
 * and Web-standard APIs only, so it runs on Node, Bun, Deno, Cloudflare Workers and in Next.js route handlers.
 *
 * @packageDocumentation
 */
export type {
  ActivityLogFilters,
  ActivityLogPage,
  ActivityOutcome,
  ActivityRow,
  ActivityTopUsers,
} from './activity.js';
export { createShardlensClient, type ShardlensActivity, type ShardlensClient } from './client.js';
export { ShardlensClientError } from './errors.js';
export { lastDays } from './range.js';
export type {
  AudienceResult,
  BurstsResult,
  CommandResult,
  CommandRow,
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
  KeyCount,
  LiveUpdate,
  Meta,
  NullableKeyCount,
  OverviewResult,
  PremiumResult,
  QueryResults,
  ReliabilityResult,
  RetentionResult,
  SdkInstance,
  SeriesResult,
  ServerProfile,
  ServerResult,
  ServerRow,
  ServersResult,
  TopResult,
} from './results.js';
export type {
  AudienceQuery,
  BurstsQuery,
  CommandQuery,
  CommandsQuery,
  Dimension,
  EventPropsQuery,
  EventsQuery,
  Filter,
  FunnelQuery,
  GaugeQuery,
  GrowthQuery,
  HeatmapQuery,
  InstallsQuery,
  OverviewQuery,
  PremiumQuery,
  QuerySpec,
  ReliabilityQuery,
  RetentionQuery,
  SeriesMetric,
  SeriesQuery,
  ServerQuery,
  ServersQuery,
  Stat,
  Step,
  TimeRange,
  TopQuery,
} from './specs.js';
export type { RequestOptions, ShardlensClientOptions } from './transport.js';
