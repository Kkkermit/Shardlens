import {
  INSTALL,
  INSTALL_NAME,
  KIND,
  KIND_NAME,
  MEMBER_TIER,
  MEMBER_TIER_NAME,
  OUTCOME,
  OUTCOME_NAME,
} from '../ingest/codes.js';
import { QueryError } from './error.js';
import type { Filter } from './spec.js';

/** Dimensions stored as small integers in rollups: names on the API, codes in the store. */
const CODED: Record<string, { encode: Record<string, number>; decode: Record<number, string> }> = {
  kind: { encode: KIND, decode: KIND_NAME },
  outcome: { encode: OUTCOME, decode: OUTCOME_NAME },
  install: { encode: INSTALL, decode: INSTALL_NAME },
  tier: { encode: MEMBER_TIER, decode: MEMBER_TIER_NAME },
};

/** Turns an API value (`chat_input`) into the code rollups store (`1`). */
export function encodeValue(field: string, value: string): string {
  const coded = CODED[field];
  if (!coded) return value;
  const code = coded.encode[value];
  return code === undefined ? value : String(code);
}

/** Turns a stored code (`1`) back into its API value (`chat_input`). */
export function decodeValue(field: string | undefined, value: string): string;
export function decodeValue(field: string | undefined, value: string | null): string | null;
export function decodeValue(field: string | undefined, value: string | null): string | null {
  if (value === null || value === '' || !field) return value;
  const coded = CODED[field];
  if (!coded) return value;
  return coded.decode[Number(value)] ?? value;
}

function metricName(spec: { metric: string; name?: string | undefined }): string {
  if (spec.metric === 'custom') {
    if (!spec.name) throw new QueryError('custom metrics need a name');
    return `custom.${spec.name}`;
  }
  return spec.metric;
}

/** The dimensions each metric's rollups keep (written by the rollup job). Custom events keep none. */
const METRIC_DIMENSIONS: Record<string, readonly string[]> = {
  interactions: ['kind', 'command', 'sub', 'outcome', 'context', 'install', 'locale', 'tier'],
  'interactions.by_guild': ['kind', 'command', 'outcome', 'guild'],
  'interactions.autocomplete': ['command', 'option'],
  components: ['kind', 'custom_id', 'source', 'outcome', 'guild'],
  'modals.submitted': ['custom_id', 'outcome'],
  'modals.shown': ['command', 'custom_id'],
  'interactions.errors': ['command', 'error_class'],
  'rest.calls': ['method', 'route', 'status'],
  'rest.invalid': ['status'],
  'rest.ratelimits': ['scope', 'route'],
  'guild.joins': ['detected'],
  'guild.leaves': ['detected'],
  'guild.unavailable': ['detected'],
};

/**
 * The rollup metric to read. Interaction queries that group or filter by server read `interactions.by_guild`, which
 * keeps fewer dimensions. A dimension the metric doesn't keep is refused: it would otherwise come back as one row
 * with an empty key, or filter everything out, and look like "no data".
 */
export function resolveMetric(spec: {
  metric: string;
  name?: string | undefined;
  groupBy?: string | undefined;
  filters: readonly Filter[];
}): string {
  const named = metricName(spec);
  const fields = [...(spec.groupBy ? [spec.groupBy] : []), ...spec.filters.map((f) => f.field)];
  const perServer = named === 'interactions' && fields.includes('guild');
  const metric = perServer ? 'interactions.by_guild' : named;
  const kept = METRIC_DIMENSIONS[metric] ?? [];
  const unsupported = fields.find((f) => !kept.includes(f));
  if (unsupported) {
    const subject = perServer ? 'per-server interactions' : spec.metric === 'custom' ? 'custom events' : named;
    const instead = kept.length > 0 ? `use ${kept.join(', ')}` : 'they have no dimensions';
    throw new QueryError(`${subject} can't be grouped or filtered by ${unsupported}: ${instead}`);
  }
  return metric;
}
