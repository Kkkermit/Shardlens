import { describe, expect, it } from 'vitest';
import {
  Batch,
  containsNul,
  HISTOGRAM_BUCKETS,
  InteractionEvent,
  MAX_BATCH_EVENTS,
  parseBatch,
  Snowflake,
  UserHash,
} from '../src/index.js';
import { batch, guildInfo, interaction, USER_HASH } from './fixtures.js';

describe('Batch', () => {
  it('accepts a valid privacy-mode batch and applies defaults', () => {
    const result = Batch.safeParse(batch([interaction({ options: undefined })]));
    expect(result.success).toBe(true);
    const event = result.data?.events[0];
    expect(event?.weight).toBe(1);
    expect(event?.type === 'interaction' && event.options).toEqual([]);
  });

  it('rejects a raw snowflake in `user`', () => {
    const result = Batch.safeParse(batch([interaction({ user: '112233445566778899' })]));
    expect(result.success).toBe(false);
  });

  it('rejects an unkeyed or malformed hash', () => {
    expect(UserHash.safeParse(USER_HASH).success).toBe(true);
    expect(UserHash.safeParse('h1:2026-W46:9f3c1a0b6e2d4f7a8c5b1e3d2a4f6c8e').success).toBe(true);
    expect(UserHash.safeParse('h1:2026-11-13:9f3c1a0b6e2d4f7a8c5b1e3d2a4f6c8e').success).toBe(true);
    expect(UserHash.safeParse('h1:2026-11:9F3C1A0B6E2D4F7A8C5B1E3D2A4F6C8E').success).toBe(false);
    expect(UserHash.safeParse('h1:2026-11:9f3c').success).toBe(false);
    expect(UserHash.safeParse('h2:2026-11:9f3c1a0b6e2d4f7a8c5b1e3d2a4f6c8e').success).toBe(false);
  });

  it('rejects a privacy-mode batch carrying an actor', () => {
    const result = Batch.safeParse(batch([interaction({ actor: { userId: '112233445566778899' } })]));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('actor_in_privacy_mode');
  });

  it('accepts an actor in audit mode, and never keeps a server owner ID in any mode', () => {
    const join = {
      id: '0193f2b4-7c1a-7d4e-9a51-3c2f1e0b9a78',
      ts: 1763052121000,
      type: 'guild_join',
      info: { ...guildInfo(), ownerId: '223344556677889900' },
      detectedAtStartup: false,
    };
    const result = Batch.safeParse(
      batch([interaction({ actor: { userId: '112233445566778899', username: 'someone' } }), join], { mode: 'audit' }),
    );
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('223344556677889900');
  });

  it('rejects a non-v7 event ID', () => {
    const result = Batch.safeParse(batch([interaction({ id: '9b2c4e1a-3f5d-4c8b-9a7e-1d2f3a4b5c6d' })]));
    expect(result.success).toBe(false);
  });

  it(`rejects empty batches and batches over ${MAX_BATCH_EVENTS} events`, () => {
    expect(Batch.safeParse(batch([])).success).toBe(false);
    const many = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => interaction());
    expect(Batch.safeParse(batch(many)).success).toBe(false);
  });

  it('rejects an unknown wire version', () => {
    expect(Batch.safeParse(batch([interaction()], { v: 2 as 1 })).success).toBe(false);
  });

  it('strips unknown keys so a newer SDK of the same major still validates', () => {
    const result = InteractionEvent.safeParse({ ...interaction(), futureField: 'x' });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('futureField');
  });

  it('caps option-value strings and custom IDs', () => {
    expect(InteractionEvent.safeParse(interaction({ customId: 'x'.repeat(101) })).success).toBe(false);
    expect(InteractionEvent.safeParse(interaction({ optionValues: { category: 'x'.repeat(101) } })).success).toBe(
      false,
    );
  });

  it('requires 40-bucket latency histograms', () => {
    expect(HISTOGRAM_BUCKETS).toBe(40);
    const window = (latency: number[]) => ({
      id: '0193f2b4-7c1a-7d4e-9a51-3c2f1e0b9a79',
      ts: 1763052121000,
      type: 'rest_window',
      windowMs: 5000,
      rows: [
        { method: 'POST', route: '/interactions/:id/:token/callback', status: 204, count: 1, retries: 0, latency },
      ],
      invalid: { count401: 0, count403: 0, count429: 0, shared429: 0 },
    });
    expect(Batch.safeParse(batch([window(new Array(40).fill(0))])).success).toBe(true);
    expect(Batch.safeParse(batch([window(new Array(39).fill(0))])).success).toBe(false);
  });
});

describe('parseBatch', () => {
  it('rejects the whole batch when the envelope is invalid', () => {
    const result = parseBatch({ ...batch([interaction()]), app: { id: 'not-a-snowflake', env: 'production' } });
    expect(result.ok).toBe(false);
  });

  it('drops only the invalid and privacy-violating events', () => {
    const result = parseBatch(
      batch([
        interaction(),
        interaction({ user: '112233445566778899' }),
        interaction({ actor: { userId: '112233445566778899' } }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    expect(result.errors.map((e) => [e.index, e.reason])).toEqual([
      [1, 'invalid_event'],
      [2, 'actor_in_privacy_mode'],
    ]);
    expect(result.envelope).not.toHaveProperty('events');
  });
});

describe('input the database could not store', () => {
  it('accepts real snowflakes and refuses IDs that would overflow a 64-bit integer', () => {
    for (const id of ['112233445566778899', '1234567890123456789', '9199999999999999999']) {
      expect(Snowflake.safeParse(id).success, id).toBe(true);
    }
    for (const id of ['9223372036854775808', '99999999999999999999', '9300000000000000000', '1234', '-1', '1e18']) {
      expect(Snowflake.safeParse(id).success, id).toBe(false);
    }
  });

  it('finds NUL characters at any depth without recursing', () => {
    expect(containsNul({ a: ['x', { b: 'ok' }], c: 1, d: null })).toBe(false);
    expect(containsNul({ a: ['x', { b: 'bad\u0000' }] })).toBe(true);
    expect(containsNul({ ['key\u0000']: 1 })).toBe(true);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(containsNul(deep)).toBe(false);
  });

  it('drops only the event that carries a NUL character, and the whole batch when the envelope does', () => {
    const result = parseBatch(batch([interaction(), interaction({ command: 'a\u0000b' }), interaction()]));
    expect(result.ok && result.events).toHaveLength(2);
    expect(result.ok && result.errors).toMatchObject([{ index: 1, reason: 'invalid_event' }]);

    const envelope = parseBatch({ ...batch([interaction()]), source: { shards: [0], instance: 'host\u0000' } });
    expect(envelope.ok).toBe(false);
  });
});
