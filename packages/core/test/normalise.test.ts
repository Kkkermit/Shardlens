import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cutText, MAX_CUSTOM_ID_LENGTH, normaliseCustomId, redactSecrets } from '../src/index.js';

describe('normaliseCustomId', () => {
  it('strips snowflakes, UUIDs and numbers', () => {
    expect(normaliseCustomId('ticket:close:112233445566778899')).toBe('ticket:close:*');
    expect(normaliseCustomId('page_3')).toBe('page_*');
    expect(normaliseCustomId('vote:0193f2b4-7c1a-7d4e-9a51-3c2f1e0b9a77:yes')).toBe('vote:*:yes');
    expect(normaliseCustomId('confirm')).toBe('confirm');
    expect(normaliseCustomId(`role:${'1'.repeat(25)}`)).toBe('role:*');
  });

  it('never outputs a digit, never grows past the wire limit (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (input) => {
        const out = normaliseCustomId(input);
        expect(out).not.toMatch(/\d/);
        expect(out.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
      }),
    );
  });

  it('never leaks an embedded snowflake (property)', () => {
    const snowflake = fc.bigInt({ min: 10n ** 16n, max: 10n ** 19n }).map(String);
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), snowflake, fc.string({ maxLength: 40 }), (a, id, b) => {
        expect(normaliseCustomId(`${a}${id}${b}`)).not.toContain(id);
      }),
    );
  });
});

describe('redactSecrets', () => {
  // Fake tokens, assembled from parts so secret scanners don't mistake these fixtures for real ones.
  const botToken = ['MTk4NjIyNDgzNDcxOTI1MjQ4', 'Cl2FMQ', 'ZnCjm1XVW7vRze4b7Cq4se7kKWs'].join('.');
  // A bot with a 17-digit ID has a 23-character first token segment: base64('12345678901234567') without padding.
  const oldBotToken = ['MTIzNDU2Nzg5MDEyMzQ1Njc', 'Cl2FMQ', 'ZnCjm1XVW7vRze4b7Cq4se7kKWsAbCdEfGh'].join('.');

  it('redacts bot tokens', () => {
    expect(redactSecrets(`login failed for ${botToken}`)).toBe('login failed for [token]');
    expect(redactSecrets(oldBotToken)).toBe('[token]');
    expect(redactSecrets(`Authorization: Bot ${botToken}`)).not.toContain('ZnCjm1');
  });

  it('redacts interaction and webhook tokens in paths and URLs', () => {
    const token = btoa('interaction:1234567890123456789:made-up-for-this-test').replace(/\W/g, '');
    expect(redactSecrets(`POST /interactions/112233445566778899/${token}/callback`)).toBe(
      'POST /interactions/112233445566778899/[token]/callback',
    );
    expect(redactSecrets(`https://discord.com/api/v10/webhooks/112233445566778899/${token}`)).toBe(
      'https://discord.com/api/v10/webhooks/112233445566778899/[token]',
    );
  });

  it('redacts Authorization values and Shardlens keys', () => {
    expect(redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe('Bearer [token]');
    expect(redactSecrets('key slk_ingest_Zm9vYmFyYmF6cXV4cXV1eGNvcmdl')).toBe('key slk_ingest_[key]');
  });

  it('leaves ordinary error text alone', () => {
    const text = 'DiscordAPIError[10062]: Unknown interaction (POST /interactions/:id/:token/callback)';
    expect(redactSecrets(text)).toBe(text);
  });

  it('catches every generated bot-token shape (property)', () => {
    const b64 = fc.stringMatching(/^[A-Za-z0-9_-]+$/);
    const segment = (min: number, max: number) =>
      fc.string({
        unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
        minLength: min,
        maxLength: max,
      });
    fc.assert(
      fc.property(segment(23, 28), segment(6, 6), segment(27, 40), b64, (id, ts, hmac, prefix) => {
        const token = `${id}.${ts}.${hmac}`;
        const out = redactSecrets(`${prefix} ${token} trailing`);
        expect(out).not.toContain(hmac);
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('redaction cost', () => {
  it('stays linear on long runs of token characters', () => {
    for (const input of ['a'.repeat(20_000), `${'a'.repeat(30)}.`.repeat(700), '-'.repeat(20_000)]) {
      const started = performance.now();
      redactSecrets(input);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});

describe('cutText', () => {
  it('never ends halfway through a character and replaces lone surrogates', () => {
    expect(cutText('ab😀', 3)).toBe('ab');
    expect(cutText('ab😀', 4)).toBe('ab😀');
    expect(cutText('a\ud800b', 10)).toBe('a\ufffdb');
    expect(cutText('a\udc00', 10)).toBe('a\ufffd');
  });

  it('replaces NUL, which the collector refuses', () => {
    expect(cutText('a\0b\0', 10)).toBe('a\ufffdb\ufffd');
  });

  it('always gives well-formed text without NUL, no longer than asked (property)', () => {
    // Any UTF-16 code units, so NUL and lone and split surrogates come up.
    const units = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 300 });
    const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    fc.assert(
      fc.property(units, fc.integer({ min: 0, max: 200 }), (codes, max) => {
        const out = cutText(String.fromCharCode(...codes), max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out).not.toMatch(loneSurrogate);
        expect(out.includes('\0')).toBe(false);
      }),
    );
  });
});
