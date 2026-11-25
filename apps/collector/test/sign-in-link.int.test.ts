import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignInLinks } from '../src/security/sign-in-links.js';
import { type Harness, startHarness } from './harness.js';

describe('one-time sign-in links', () => {
  let h: Harness;
  const links = new SignInLinks();

  beforeAll(async () => {
    h = await startHarness({ signInLinks: links });
  });
  afterAll(() => h?.close());

  const cookieOf = (setCookie: string | string[] | undefined) =>
    String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];

  it('signs in as the owner once, and never again with the same link', async () => {
    const link = new URL(links.issue('http://localhost:8080'));
    expect(link.pathname).toMatch(/^\/auth\/link\/[\w-]{43}$/);

    const first = await h.app.inject({ method: 'GET', url: link.pathname });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('/');
    const cookie = cookieOf(first.headers['set-cookie']);

    const me = await h.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ authenticated: true, method: 'link', userId: null });
    // Settings are the owner's: a read-key session gets 403 here.
    const settings = await h.app.inject({ method: 'GET', url: '/v1/settings', headers: { cookie } });
    expect(settings.statusCode).toBe(200);
    const write = await h.app.inject({
      method: 'PUT',
      url: '/v1/settings',
      headers: { cookie, 'x-shardlens-csrf': '1' },
      payload: { timezone: 'Europe/London' },
    });
    expect(write.statusCode).toBe(200);
    const noCsrf = await h.app.inject({
      method: 'PUT',
      url: '/v1/settings',
      headers: { cookie },
      payload: { timezone: 'UTC' },
    });
    expect(noCsrf.statusCode).toBe(403);

    const again = await h.app.inject({ method: 'GET', url: link.pathname });
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toBe('/?error=link_expired');
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('turns away a link it did not issue', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/auth/link/${'A'.repeat(43)}` });
    expect(res.headers.location).toBe('/?error=link_expired');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('is absent from a collector without links', async () => {
    const plain = await startHarness();
    try {
      const res = await plain.app.inject({ method: 'GET', url: `/auth/link/${'A'.repeat(43)}` });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
