import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  Actor,
  BatchEnvelope,
  COLLECTED_FIELDS,
  type CollectedObject,
  Event,
  GuildInfo,
  METRICS,
  RETENTION,
} from '../src/index.js';

const BASE_FIELDS = new Set(['id', 'ts', 'weight', 'type']);

/** Every (object, field) pair in the wire format, derived from the zod schemas themselves. */
function wireFields(): Set<string> {
  const out = new Set<string>();
  const add = (object: CollectedObject, shape: Record<string, unknown>) => {
    for (const key of Object.keys(shape)) out.add(`${object}.${key}`);
  };
  add('envelope', BatchEnvelope.shape);
  add('actor', Actor.shape);
  add('guild_info', GuildInfo.shape);
  for (const option of Event.options) {
    const shape = option.shape as Record<string, z.ZodType>;
    const type = (option.shape.type as z.ZodLiteral<string>).value as CollectedObject;
    for (const key of Object.keys(shape)) out.add(BASE_FIELDS.has(key) ? `event.${key}` : `${type}.${key}`);
  }
  return out;
}

describe('collected-fields register', () => {
  const documented = new Set(COLLECTED_FIELDS.map((f) => `${f.object}.${f.field}`));

  it('documents every field the wire format can carry', () => {
    const missing = [...wireFields()].filter((key) => !documented.has(key));
    expect(missing, 'add these to src/collected-fields.ts').toEqual([]);
  });

  it('documents no field that the wire format does not have', () => {
    const wire = wireFields();
    const stale = [...documented].filter((key) => !wire.has(key));
    expect(stale, 'remove these from src/collected-fields.ts').toEqual([]);
  });

  it('has no duplicates and only known retention keys', () => {
    expect(documented.size).toBe(COLLECTED_FIELDS.length);
    for (const field of COLLECTED_FIELDS) expect(Object.keys(RETENTION)).toContain(field.retention);
  });

  it('marks every identifying field except the dashboard allow-list as audit-only', () => {
    const identifyingInPrivacy = COLLECTED_FIELDS.filter((f) => f.personal === 'yes' && f.mode === 'privacy').map(
      (f) => `${f.object}.${f.field}`,
    );
    expect(identifyingInPrivacy).toEqual(['app_info.dashboardUserIds']);
  });
});

describe('metric registry', () => {
  it('has unique, stable names', () => {
    const names = METRICS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_<>]+)*$/);
  });

  it('only derives metrics from known sources', () => {
    const eventTypes = new Set<string>(Event.options.map((o) => (o.shape.type as z.ZodLiteral<string>).value));
    eventTypes.add('webhook'); // received by the collector over HTTP, not from the SDK
    for (const metric of METRICS) for (const source of metric.source) expect(eventTypes).toContain(source);
  });
});
