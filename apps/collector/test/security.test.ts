import { generateKeyPairSync, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isDiscordWebhookUrl, maskWebhook } from '../src/discord-webhook.js';
import { auditCipher } from '../src/security/crypto.js';
import { csvCell, csvRow } from '../src/security/csv.js';
import { makeDiscordVerifier } from '../src/security/ed25519.js';
import { gunzipBounded } from '../src/security/gzip.js';
import { apiKeyScope, newApiKey } from '../src/security/keys.js';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  return { publicKeyHex: Buffer.from(x, 'base64url').toString('hex'), privateKey };
}

describe('Discord webhook signature (Ed25519)', () => {
  const { publicKeyHex, privateKey } = keyPair();
  const verifyRequest = makeDiscordVerifier(publicKeyHex);
  const now = 1_763_052_121;
  const body = Buffer.from('{"version":1,"application_id":"1234567890123456789","type":0}');
  const signFor = (ts: string, payload: Buffer) =>
    sign(null, Buffer.concat([Buffer.from(ts), payload]), privateKey).toString('hex');

  it('accepts a valid signature', () => {
    expect(verifyRequest(body, signFor(String(now), body), String(now), now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(body.toString().replace('"type":0', '"type":1'));
    expect(verifyRequest(tampered, signFor(String(now), body), String(now), now)).toBe(false);
  });

  it('rejects a signature from another key', () => {
    const other = keyPair();
    const sig = sign(null, Buffer.concat([Buffer.from(String(now)), body]), other.privateKey).toString('hex');
    expect(verifyRequest(body, sig, String(now), now)).toBe(false);
  });

  it('rejects stale and future timestamps (replay window 5 minutes)', () => {
    const stale = String(now - 301);
    const future = String(now + 301);
    expect(verifyRequest(body, signFor(stale, body), stale, now)).toBe(false);
    expect(verifyRequest(body, signFor(future, body), future, now)).toBe(false);
  });

  it('rejects malformed headers', () => {
    const ts = String(now);
    expect(verifyRequest(body, undefined, ts, now)).toBe(false);
    expect(verifyRequest(body, signFor(ts, body), undefined, now)).toBe(false);
    expect(verifyRequest(body, 'zz'.repeat(64), ts, now)).toBe(false);
    expect(verifyRequest(body, signFor(ts, body).slice(2), ts, now)).toBe(false);
    expect(verifyRequest(body, signFor(ts, body), '17630521e2', now)).toBe(false);
  });

  it('refuses to start with a malformed public key', () => {
    expect(() => makeDiscordVerifier('not-hex')).toThrow();
  });
});

describe('audit cipher (AES-256-GCM)', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const cipher = auditCipher(key);

  it('round-trips and uses a fresh IV each time', () => {
    const a = cipher.encrypt('112233445566778899');
    const b = cipher.encrypt('112233445566778899');
    expect(cipher.decrypt(a)).toBe('112233445566778899');
    expect(a.equals(b)).toBe(false);
  });

  it('detects tampering and wrong keys', () => {
    const blob = cipher.encrypt('112233445566778899');
    blob[blob.length - 1]! ^= 1;
    expect(() => cipher.decrypt(blob)).toThrow();
    const other = auditCipher(Buffer.alloc(32, 8).toString('base64'));
    expect(() => other.decrypt(cipher.encrypt('x'))).toThrow();
    expect(() => cipher.decrypt(Buffer.alloc(10))).toThrow();
  });

  it('gives a deterministic 16-byte lookup key per user', () => {
    expect(cipher.lookupHash('112233445566778899').equals(cipher.lookupHash('112233445566778899'))).toBe(true);
    expect(cipher.lookupHash('112233445566778899').equals(cipher.lookupHash('223344556677889900'))).toBe(false);
    expect(cipher.lookupHash('112233445566778899')).toHaveLength(16);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => auditCipher(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('API keys', () => {
  it('creates scoped keys and stores only a SHA-256', () => {
    const { plaintext, sha256 } = newApiKey('ingest');
    expect(plaintext).toMatch(/^slk_ingest_[\w-]{43}$/);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256).not.toContain(plaintext.slice(11));
    expect(apiKeyScope(plaintext)).toBe('ingest');
    expect(apiKeyScope(newApiKey('read').plaintext)).toBe('read');
    expect(apiKeyScope('Bearer nonsense')).toBeUndefined();
  });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("https://evil.example","click")')).toBe(
      '"\'=HYPERLINK(""https://evil.example"",""click"")"',
    );
    for (const prefix of ['=', '+', '-', '@', '\t', '\r'])
      expect(csvCell(`${prefix}1`).replace(/^"/, '')).toMatch(/^'/);
  });

  it('quotes commas, quotes and newlines; empties null', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvRow(['ticket', 3, undefined])).toBe('ticket,3,\r\n');
  });
});

describe('alert and report webhook allow-list (SSRF)', () => {
  it('allows Discord webhook URLs only', () => {
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/112233445566778899/abc-DEF_123')).toBe(true);
    expect(isDiscordWebhookUrl('https://canary.discord.com/api/v10/webhooks/112233445566778899/abc')).toBe(true);
  });

  it('rejects other hosts, schemes, ports and tricks', () => {
    for (const url of [
      'http://discord.com/api/webhooks/112233445566778899/abc',
      'https://evil.example/api/webhooks/112233445566778899/abc',
      'https://discord.com.evil.example/api/webhooks/112233445566778899/abc',
      'https://discord.com@evil.example/api/webhooks/112233445566778899/abc',
      'https://discord.com:8443/api/webhooks/112233445566778899/abc',
      'https://discord.com/api/webhooks/112233445566778899/abc?wait=true',
      'https://discord.com/api/users/@me',
      'https://169.254.169.254/latest/meta-data',
      'not a url',
    ]) {
      expect(isDiscordWebhookUrl(url), url).toBe(false);
    }
  });

  it('masks a stored webhook so it can be recognised but not used', () => {
    const masked = maskWebhook('https://discord.com/api/webhooks/112233445566778899/abc-DEF_123');
    expect(masked).toBe('https://discord.com/api/webhooks/1122…/•••');
    expect(maskWebhook('anything else')).toBe('•••');
  });
});

describe('gzip-bomb guard', () => {
  it('rejects 6 MB of zeros at the 5 MB cap', async () => {
    const bomb = gzipSync(Buffer.alloc(6 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(10_000);
    await expect(gunzipBounded(bomb)).rejects.toThrow(RangeError);
  });

  it('passes normal bodies through', async () => {
    const json = Buffer.from(JSON.stringify({ v: 1, events: new Array(500).fill({ type: 'custom' }) }));
    expect((await gunzipBounded(gzipSync(json))).equals(json)).toBe(true);
  });
});
