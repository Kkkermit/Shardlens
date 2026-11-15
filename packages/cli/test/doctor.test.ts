import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Check, doctor } from '../src/doctor.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const key = `slk_ingest_${'A'.repeat(43)}`;
const config = { appId: '1234567890123456789', mode: 'privacy', saltPeriod: 'month', salts: [{}] };

/** A fake collector that records every request it gets. */
function collector(answer: (path: string) => Response | Promise<Response> = defaultAnswer) {
  const requests: { url: string; authorization: string | null; redirect: RequestInit['redirect'] }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      url: url.href,
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    });
    return answer(url.pathname);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

function defaultAnswer(path: string): Response {
  return path === '/healthz' ? Response.json({ ok: true }) : Response.json(config);
}

const find = (checks: Check[], name: string) => checks.find((c) => c.name === name);
const failed = (checks: Check[]) => checks.filter((c) => !c.ok && !c.warnOnly);

describe('doctor', () => {
  it('checks the collector and key without sending the key anywhere else', async () => {
    const { requests, fetchImpl } = collector();
    const checks = await doctor({ url: 'https://stats.example.com', key, fetchImpl });
    expect(failed(checks)).toEqual([]);
    expect(find(checks, 'Collector URL')).toMatchObject({ detail: 'https://stats.example.com' });
    expect(find(checks, 'Data mode')).toMatchObject({ detail: 'privacy mode, salts rotate every month' });
    expect(requests.map((r) => r.url)).toEqual([
      'https://stats.example.com/healthz',
      'https://stats.example.com/v1/config',
    ]);
    expect(requests.map((r) => r.authorization)).toEqual([null, `Bearer ${key}`]);
  });

  it('sends nothing to a plain-HTTP collector that is not on this machine, so the key never travels unencrypted', async () => {
    const { requests, fetchImpl } = collector();
    const checks = await doctor({ url: 'http://stats.example.com', key, fetchImpl });
    expect(find(checks, 'Collector URL')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('must be HTTPS'),
    });
    expect(find(checks, 'Ingest key')).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('allows plain HTTP to localhost for development', async () => {
    const { fetchImpl } = collector();
    const checks = await doctor({ url: 'http://localhost:8080', key, fetchImpl });
    expect(failed(checks)).toEqual([]);
    expect(find(checks, 'Collector URL')?.detail).toContain('development only');
  });

  it('reports a redirect instead of following it, where the key would be dropped or sent elsewhere', async () => {
    const { requests, fetchImpl } = collector(
      () => new Response(null, { status: 308, headers: { location: 'https://localhost/healthz' } }),
    );
    const checks = await doctor({ url: 'http://localhost:8080', key, fetchImpl });
    expect(find(checks, 'Collector reachable')).toMatchObject({
      ok: false,
      detail: 'redirects to https://localhost/healthz (308): use the address it redirects to',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe('manual');
  });

  it('stops at a proxy whose collector is down, instead of blaming the key', async () => {
    const { requests, fetchImpl } = collector(() => new Response('', { status: 502 }));
    const checks = await doctor({ url: 'https://stats.example.com', key, fetchImpl });
    expect(find(checks, 'Collector reachable')).toMatchObject({
      ok: false,
      detail: "answered 502: a proxy is there, but the collector behind it isn't answering",
    });
    expect(find(checks, 'Ingest key')).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it('does not take any page that answers 200 for a collector', async () => {
    const { fetchImpl } = collector(() => new Response('<!doctype html><title>My site</title>', { status: 200 }));
    const checks = await doctor({ url: 'https://example.com', key, fetchImpl });
    expect(find(checks, 'Collector reachable')).toMatchObject({
      ok: false,
      detail: "answered, but it isn't a Shardlens collector",
    });
  });

  it('refuses a collector URL with a user name or password, without printing it or calling it', async () => {
    const { requests, fetchImpl } = collector();
    const checks = await doctor({ url: 'https://user:hunter2@stats.example.com', fetchImpl });
    expect(find(checks, 'Collector URL')).toMatchObject({ ok: false });
    expect(JSON.stringify(checks)).not.toContain('hunter2');
    expect(requests).toEqual([]);
  });

  it('says why a request failed, and what to do about an untrusted certificate', async () => {
    const fail = (code: string) =>
      (async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) });
      }) as typeof fetch;
    const reachable = async (code: string) =>
      find(await doctor({ url: 'https://stats.example.com', fetchImpl: fail(code) }), 'Collector reachable');
    expect(await reachable('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(
        /^its certificate isn't trusted\. .*NODE_EXTRA_CA_CERTS.*\(UNABLE_TO_GET_ISSUER_CERT_LOCALLY\)$/,
      ),
    });
    expect((await reachable('ENOTFOUND'))?.detail).toBe('no DNS record for stats.example.com (ENOTFOUND)');
    expect((await reachable('ECONNREFUSED'))?.detail).toBe(
      'nothing accepts connections on stats.example.com port 443 (ECONNREFUSED)',
    );
    expect((await reachable('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'))?.detail).toBe(
      'it refused the TLS handshake, usually because it has no certificate for stats.example.com (ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR)',
    );
    expect((await reachable('EWHATEVER'))?.detail).toBe('fetch failed (EWHATEVER)');
  });

  it('says when the collector took too long', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;
    const checks = await doctor({ url: 'https://stats.example.com', fetchImpl });
    expect(find(checks, 'Collector reachable')?.detail).toBe('no answer within 5 seconds');
  });

  it('tells a rejected key, a read key and a malformed key apart', async () => {
    const { fetchImpl } = collector((path) =>
      path === '/healthz' ? Response.json({ ok: true }) : Response.json({ error: 'unauthorized' }, { status: 401 }),
    );
    const ingest = async (k: string) =>
      find(await doctor({ url: 'https://stats.example.com', key: k, fetchImpl }), 'Ingest key');
    expect(await ingest(key)).toMatchObject({ ok: false, detail: expect.stringContaining('rejected (401)') });
    expect((await ingest(`slk_read_${'A'.repeat(43)}`))?.detail).toContain('this is a read key');
    expect((await ingest('hunter2'))?.detail).toContain('not an ingest key');
  });

  it('reports a missing salt once, without contradicting the key check', async () => {
    const { fetchImpl } = collector((path) =>
      path === '/healthz' ? Response.json({ ok: true }) : Response.json({ ...config, salts: undefined }),
    );
    const checks = await doctor({ url: 'https://stats.example.com', key, fetchImpl });
    expect(checks.filter((c) => c.name === 'Ingest key')).toEqual([expect.objectContaining({ ok: true })]);
    expect(find(checks, 'Salt available')).toMatchObject({ ok: false, detail: 'no salt served' });
  });

  it("reads the discord.js version even when the package doesn't export its package.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shardlens-doctor-'));
    dirs.push(dir);
    const djs = join(dir, 'node_modules', 'discord.js');
    await mkdir(djs, { recursive: true });
    await writeFile(
      join(djs, 'package.json'),
      JSON.stringify({ name: 'discord.js', version: '15.0.0', exports: { '.': './index.js' } }),
    );
    const nested = join(dir, 'src', 'bot');
    await mkdir(nested, { recursive: true });
    expect(find(await doctor({ cwd: nested }), 'discord.js')).toMatchObject({ ok: true, detail: '15.0.0' });
  });

  it('accepts discord.js 14.12 and newer and 15, and says so for an older 14', async () => {
    const check = async (version: string) => {
      const dir = await mkdtemp(join(tmpdir(), 'shardlens-doctor-'));
      dirs.push(dir);
      const djs = join(dir, 'node_modules', 'discord.js');
      await mkdir(djs, { recursive: true });
      await writeFile(join(djs, 'package.json'), JSON.stringify({ name: 'discord.js', version }));
      return find(await doctor({ cwd: dir }), 'discord.js');
    };
    for (const version of ['14.12.0', '14.28.1', '15.0.0-dev.1794009739-5bb74922a']) {
      expect(await check(version), version).toMatchObject({ ok: true });
    }
    for (const version of ['14.11.0', '13.17.1']) {
      expect(await check(version), version).toMatchObject({
        ok: false,
        detail: `${version} (Shardlens supports 14.12 and newer, and 15)`,
      });
    }
  });

  it('passes the discord.js check for an HTTP-interactions bot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shardlens-doctor-'));
    dirs.push(dir);
    const http = join(dir, 'node_modules', '@shardlens', 'http');
    await mkdir(http, { recursive: true });
    await writeFile(join(http, 'package.json'), JSON.stringify({ name: '@shardlens/http', version: '0.1.0' }));
    const found = find(await doctor({ cwd: dir }), 'discord.js');
    expect(found).toMatchObject({ ok: true });
    expect(found?.detail).toContain('@shardlens/http');
  });

  it('warns rather than fails when discord.js is not installed, and says where it looked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shardlens-doctor-'));
    dirs.push(dir);
    expect(find(await doctor({ cwd: dir }), 'discord.js')).toMatchObject({
      ok: false,
      warnOnly: true,
      detail: expect.stringContaining(dir),
    });
  });
});
