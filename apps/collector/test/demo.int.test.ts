import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

// SHARDLENS_DEMO=true is for the public demo instance: anyone may read, nothing else opens up.
let h: Harness;

beforeAll(async () => {
  h = await startHarness({ demo: true });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('demo mode', () => {
  it('treats visitors as read-only viewers', async () => {
    const me = await h.app.inject({ method: 'GET', url: '/auth/me' });
    expect(me.json()).toMatchObject({ authenticated: true, method: 'demo', userId: null, demo: true });

    const meta = await h.app.inject({ method: 'GET', url: '/v1/meta' });
    expect(meta.statusCode).toBe(200);

    const now = Date.now();
    const q = await h.app.inject({
      method: 'POST',
      url: '/v1/query',
      payload: {
        kind: 'commands',
        range: { from: new Date(now - 86_400_000).toISOString(), to: new Date(now).toISOString() },
      },
    });
    expect(q.statusCode).toBe(200);
  });

  it('keeps admin, audit, erasure and ingest locked', async () => {
    const locked = [
      { method: 'GET', url: '/v1/settings' },
      { method: 'GET', url: '/v1/keys' },
      { method: 'GET', url: '/v1/alerts' },
      { method: 'GET', url: '/v1/audit/log' },
      { method: 'GET', url: '/v1/config' },
      { method: 'POST', url: '/v1/privacy/erase', payload: { userId: '555555555555555555' } },
      { method: 'POST', url: '/v1/ingest', payload: {} },
    ] as const;
    for (const req of locked) {
      const res = await h.app.inject({ ...req, headers: { 'x-shardlens-csrf': '1' } });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(401);
    }
  });
});
