import { describe, expect, it } from 'vitest';
import { commandFound, MAX_COMMAND_NAME } from '../src/commands';
import { overviewRefreshMs } from '../src/freshness';
import { lastDays } from '../src/range';
import { nextSort } from '../src/table-sort';

describe('sorting a table by its headers', () => {
  it('starts a column in its own direction and flips it on the next click', () => {
    expect(nextSort(undefined, 'name', 'asc')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'members', dir: 'desc' }, 'name', 'asc')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name', 'asc')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'runs', dir: 'desc' }, 'runs', 'desc')).toEqual({ key: 'runs', dir: 'asc' });
  });
});

describe('unknown commands', () => {
  it('is found when the list over the last 90 days has it, registered or run', () => {
    const rows = [{ command: 'ticket' }, { command: 'legacy-stats' }];
    expect(commandFound('legacy-stats', rows)).toBe(true);
    expect(commandFound('nope', rows)).toBe(false);
    expect(commandFound('Ticket', rows)).toBe(false);
    expect(commandFound('ticket', undefined)).toBeUndefined();
    expect(MAX_COMMAND_NAME).toBe(32);
  });
});

describe('ranges', () => {
  it('end at the next whole minute, so pages asking within a minute share answers', () => {
    const now = Date.UTC(2026, 10, 15, 16, 20, 30);
    expect(lastDays(1, now)).toEqual({ from: '2026-11-14T16:21:00.000Z', to: '2026-11-15T16:21:00.000Z' });
    expect(lastDays(90, now)).toEqual(lastDays(90, now + 15_000));
  });
});

describe('an Overview left open', () => {
  it('asks again every few seconds until the first events show, then once a minute', () => {
    expect(overviewRefreshMs(undefined)).toBe(10_000);
    expect(overviewRefreshMs({ lastEventAt: null })).toBe(10_000);
    expect(overviewRefreshMs({ lastEventAt: '2026-11-15T16:20:00Z' })).toBe(60_000);
  });
});
