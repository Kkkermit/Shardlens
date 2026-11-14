import { GatewayDispatchEvents } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { GATEWAY_EVENT_COVERAGE, REQUIRED_INTENTS } from '../src/index.js';

describe('Gateway event coverage', () => {
  const covered = GATEWAY_EVENT_COVERAGE.map((row) => row.event);

  it('decides how to treat every dispatch event in discord-api-types', () => {
    const unmapped = Object.values(GatewayDispatchEvents).filter((event) => !covered.includes(event));
    expect(unmapped, 'map these in src/gateway-events.ts and record the decision in an ADR').toEqual([]);
  });

  it('lists no event that discord-api-types no longer has', () => {
    const known = new Set<string>(Object.values(GatewayDispatchEvents));
    expect(covered.filter((event) => !known.has(event))).toEqual([]);
  });

  it('lists each event once', () => {
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('collects nothing in v1 that needs an intent other than Guilds', () => {
    const used = GATEWAY_EVENT_COVERAGE.filter((row) => row.use === 'used');
    for (const row of used) expect(row.intent === null || REQUIRED_INTENTS.includes(row.intent)).toBe(true);
  });

  it('never uses a privileged event outside an opt-in plugin', () => {
    const privileged = GATEWAY_EVENT_COVERAGE.filter((row) => row.privileged);
    for (const row of privileged) expect(['plugin', 'never']).toContain(row.use);
  });
});
