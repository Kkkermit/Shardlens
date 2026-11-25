import { Snowflake } from '@shardlens/schema';
import { z } from 'zod';

const MAX_RANGE_DAYS = 400;

const SeriesMetric = z.enum([
  'interactions',
  'interactions.autocomplete',
  'components',
  'modals.submitted',
  'modals.shown',
  'interactions.errors',
  'rest.calls',
  'rest.invalid',
  'rest.ratelimits',
  'guild.joins',
  'guild.leaves',
  'guild.unavailable',
  'custom',
]);

/**
 * Dimensions that can be grouped or filtered on. These are keys inside rollup `dims`, passed to SQL as bound
 * parameters. There is deliberately no user dimension: per-user views are impossible by construction.
 */
const Dimension = z.enum([
  'command',
  'sub',
  'kind',
  'outcome',
  'context',
  'install',
  'guild',
  'locale',
  'tier',
  'custom_id',
  'source',
  'option',
  'error_class',
  'method',
  'route',
  'status',
  'scope',
  'detected',
]);

const Iso = z.iso.datetime({ offset: true });

const knownZones = new Map<string, boolean>();
/**
 * Any IANA name the runtime knows, aliases included (`Asia/Kolkata` and `Asia/Calcutta`): browsers list different
 * spellings of the same zone, and `Intl.supportedValuesOf` gives only one of them.
 */
function isTimeZone(tz: string): boolean {
  let known = knownZones.get(tz);
  if (known === undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      known = /^[A-Za-z][\w+-]*(\/[A-Za-z0-9][\w+-]*)*$/.test(tz);
    } catch {
      known = false;
    }
    if (knownZones.size < 2_000) knownZones.set(tz, known);
  }
  return known;
}

/** A time zone name with no default, for a settings patch that may leave it out. */
export const TimeZoneName = z.string().max(64).refine(isTimeZone, 'unknown time zone');
const TimeZone = TimeZoneName.default('UTC');

const Range = z
  .object({ from: Iso, to: Iso })
  .refine((r) => Date.parse(r.from) < Date.parse(r.to), 'from must be before to')
  .refine(
    (r) => Date.parse(r.to) - Date.parse(r.from) <= MAX_RANGE_DAYS * 86_400_000,
    `range is limited to ${MAX_RANGE_DAYS} days`,
  );

const Filter = z.object({
  field: Dimension,
  op: z.enum(['eq', 'in']).default('eq'),
  value: z.union([z.string().max(200), z.array(z.string().max(200)).min(1).max(100)]),
});

const Stat = z.enum(['count', 'sum', 'avg', 'p50', 'p95', 'p99']);

const CustomName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** A funnel or cohort step: a custom event or a command. Never a user. */
const Step = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), name: CustomName }),
  z.object({ type: z.literal('command'), name: z.string().min(1).max(32) }),
]);

export const QuerySpec = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('series'),
    metric: SeriesMetric,
    /** For `custom`: the event name. */
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional(),
    range: Range,
    interval: z.enum(['minute', 'hour', 'day', 'week', 'month']),
    groupBy: Dimension.optional(),
    stat: Stat.default('count'),
    filters: z.array(Filter).max(10).default([]),
    timezone: TimeZone,
    limit: z.number().int().min(1).max(20).default(10),
  }),
  z.object({
    kind: z.literal('top'),
    metric: SeriesMetric,
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional(),
    range: Range,
    groupBy: Dimension,
    stat: Stat.default('count'),
    filters: z.array(Filter).max(10).default([]),
    limit: z.number().int().min(1).max(500).default(20),
  }),
  z.object({
    kind: z.literal('heatmap'),
    metric: SeriesMetric.default('interactions'),
    range: Range,
    filters: z.array(Filter).max(10).default([]),
    timezone: TimeZone,
  }),
  z.object({ kind: z.literal('commands'), range: Range }),
  z.object({ kind: z.literal('command'), name: z.string().min(1).max(32), range: Range }),
  z.object({
    kind: z.literal('servers'),
    search: z.string().max(100).optional(),
    status: z.enum(['active', 'left', 'all']).default('active'),
    feature: z.string().max(64).optional(),
    locale: z.string().max(10).optional(),
    size: z.enum(['1-10', '11-100', '101-1k', '1k-10k', '10k+']).optional(),
    inactive: z.boolean().optional(),
    missingPermissions: z.boolean().optional(),
    sort: z.enum(['members', 'joined', 'last_active', 'runs', 'name']).default('members'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).max(1_000_000).default(0),
  }),
  z.object({ kind: z.literal('server'), guild: Snowflake }),
  z.object({ kind: z.literal('growth'), range: Range, timezone: TimeZone }),
  z.object({ kind: z.literal('audience'), range: Range }),
  z.object({ kind: z.literal('overview') }),
  z.object({
    kind: z.literal('gauge'),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_.]{0,63}$/)
      .max(64),
    range: Range,
    interval: z.enum(['minute', 'hour', 'day']),
    perShard: z.boolean().default(false),
    timezone: TimeZone,
  }),
  z.object({ kind: z.literal('bursts'), range: Range, factor: z.number().min(2).max(50).default(5) }),
  z.object({ kind: z.literal('reliability'), range: Range }),
  z.object({ kind: z.literal('premium'), range: Range }),
  z.object({ kind: z.literal('installs'), range: Range, timezone: TimeZone }),
  z.object({ kind: z.literal('events'), range: Range }),
  z.object({
    kind: z.literal('eventProps'),
    name: CustomName,
    range: Range,
    prop: z.string().min(1).max(64).optional(),
  }),
  z.object({
    kind: z.literal('funnel'),
    steps: z.array(Step).min(2).max(5),
    range: Range,
    /** Every step must happen within this many hours of the first. */
    windowHours: z.number().int().min(1).max(168).default(24),
    timezone: TimeZone,
  }),
  z.object({
    kind: z.literal('retention'),
    start: Step,
    return: z.union([Step, z.literal('any')]).default('any'),
    range: Range,
    interval: z.enum(['day', 'week']).default('week'),
    timezone: TimeZone,
  }),
]);

export type QuerySpec = z.output<typeof QuerySpec>;
/** The spec of one query kind. */
export type Spec<K extends QuerySpec['kind']> = Extract<QuerySpec, { kind: K }>;
export type Filter = z.output<typeof Filter>;
