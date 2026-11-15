/**
 * `@shardlens/core`: the library-agnostic heart of the Shardlens SDK. Zero runtime dependencies and Web-standard APIs
 * only (`fetch`, Web Crypto, `CompressionStream`), so it runs on Node 22.12+, Bun, Deno and Cloudflare Workers.
 *
 * @packageDocumentation
 */
export { avatarHash, compact, errorClass, errorCode, recordedOptionValue } from './adapter-helpers.js';
export {
  type ClientOptions,
  type ClientStats,
  type DataMode,
  type FlushOptions,
  type Logger,
  nextPeriodStart,
  ShardlensClient,
  type SourceInfo,
  type WireEvent,
} from './client.js';
export {
  CUSTOM_EVENT_NAME,
  type CustomEventName,
  type CustomEventProps,
  type CustomEvents,
  type CustomProps,
  type CustomPropValue,
  MAX_CUSTOM_PROPS_BYTES,
  sanitiseCustomProps,
} from './custom-events.js';
export {
  DEFAULT_DURATION_BUCKETS,
  EXPORTER_METRICS,
  type ExporterMetric,
  type ExporterMetricName,
  type MetricLabels,
  type MetricSink,
  type ShardlensExporter,
  translateEvent,
} from './exporter.js';
export { HASH_BYTES, HASH_VERSION, periodLabel, type SaltPeriod, UserHasher } from './hash.js';
export {
  BUCKETS,
  bucketOf,
  bucketUpperMs,
  type Histogram,
  MAX_MS,
  mergeHistograms,
  newHistogram,
  observe,
  quantile,
} from './histogram.js';
export { cutText, MAX_CUSTOM_ID_LENGTH, normaliseCustomId, redactSecrets } from './normalise.js';
export { BoundedQueue, PRIORITIES, type Priority, type QueuedItem } from './queue.js';
export type { EventSpool } from './spool.js';
export { BACKOFF_MAX_MS, BACKOFF_MIN_MS, backoffMs, gzipJson, isAllowedEndpoint } from './transport.js';
export { uuidv7, uuidv7Timestamp } from './uuidv7.js';
