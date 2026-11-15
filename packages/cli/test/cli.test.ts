import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctor, init, newKey, privacyParagraph, readBotEnv } from '../src/commands.js';
import { run } from '../src/run.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('command line', () => {
  it('prints help for --help wherever it is, and for no command at all', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const argv of [['--help'], ['-h'], ['init', '--help'], ['help'], []]) {
      out.mockClear();
      expect(await run(argv)).toBe(0);
      expect(out.mock.calls[0]?.[0]).toContain('shardlens <command> [options]');
    }
    expect(err).not.toHaveBeenCalled();
  });

  it('refuses an unknown command or a stray argument with exit code 2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['deploy'])).toBe(2);
    expect(err.mock.calls[0]?.[0]).toContain('Unknown command "deploy"');
    expect(await run(['keys', 'read'])).toBe(2);
    expect(err.mock.calls[1]?.[0]).toContain('Unexpected argument "read"');
  });
});

describe('keys', () => {
  it('generates keys in the format the collector accepts', () => {
    expect(newKey('ingest')).toMatch(/^slk_ingest_[\w-]{43}$/);
    expect(newKey('read')).toMatch(/^slk_read_[\w-]{43}$/);
    expect(newKey('ingest')).not.toBe(newKey('ingest'));
  });
});

describe('init', () => {
  it('writes the deployment files with fresh secrets and refuses to overwrite .env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shardlens-init-'));
    dirs.push(dir);
    const result = await init({ dir, domain: 'stats.example.com', appId: '1234567890123456789' });
    expect(result.written).toEqual(['docker-compose.yml', 'Caddyfile', '.env', 'bot.env']);
    const env = await readFile(join(dir, '.env'), 'utf8');
    // bot.env holds exactly what the bot needs: the collector's address and the same ingest key, readable by its owner.
    const bot = await readFile(join(dir, 'bot.env'), 'utf8');
    const ingest = /^SHARDLENS_INGEST_KEY=(slk_ingest_[\w-]{43})$/m.exec(env)?.[1];
    expect(ingest).toBeDefined();
    expect(bot).toContain(`SHARDLENS_INGEST_KEY=${ingest}`);
    expect(bot).toContain('SHARDLENS_URL=https://stats.example.com');
    expect(bot).not.toMatch(/READ_KEY|SESSION_SECRET|SETTINGS_KEY|POSTGRES_PASSWORD/);
    if (process.platform !== 'win32') expect((await stat(join(dir, 'bot.env'))).mode & 0o777).toBe(0o600);
    expect(env).toMatch(/^SHARDLENS_INGEST_KEY=slk_ingest_[\w-]{43}$/m);
    expect(env).toMatch(/^SHARDLENS_SETTINGS_KEY=.{44}$/m);
    expect(env).toContain('SHARDLENS_PUBLIC_URL=https://stats.example.com');
    const compose = await readFile(join(dir, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('postgres:');
    await expect(init({ dir, domain: 'stats.example.com', appId: '1234567890123456789' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('leaves the audit key commented out unless identified users were asked for', async () => {
    const hashed = await mkdtemp(join(tmpdir(), 'shardlens-init-'));
    const identified = await mkdtemp(join(tmpdir(), 'shardlens-init-'));
    dirs.push(hashed, identified);
    const options = { domain: 'stats.example.com', appId: '1234567890123456789' };
    await init({ ...options, dir: hashed });
    await init({ ...options, dir: identified, identifyUsers: true });
    expect(await readFile(join(hashed, '.env'), 'utf8')).toMatch(/^# SHARDLENS_AUDIT_KEY=.{44}$/m);
    expect(await readFile(join(identified, '.env'), 'utf8')).toMatch(/^SHARDLENS_AUDIT_KEY=.{44}$/m);
  });

  it('validates the domain and application ID', async () => {
    await expect(init({ dir: 'x', domain: 'not a host', appId: '1234567890123456789' })).rejects.toThrow(/domain/);
    await expect(init({ dir: 'x', domain: 'stats.example.com', appId: 'abc' })).rejects.toThrow(/app-id/);
  });
});

describe('privacy', () => {
  it('describes privacy mode by default and audit mode only when asked', () => {
    const privacy = privacyParagraph({});
    expect(privacy).toContain('pseudonymous code');
    expect(privacy).not.toContain('encrypted');
    const audit = privacyParagraph({ audit: true, optionValues: ['category'] });
    expect(audit).toContain('user ID, username and avatar');
    expect(privacyParagraph({ audit: true, idsOnly: true })).not.toContain('username');
    expect(audit).toContain('"category"');
  });
});

describe('readBotEnv', () => {
  it('reads the two settings from a .env without changing the environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shardlens-botenv-'));
    expect(await readBotEnv(dir)).toEqual({});
    const key = `slk_ingest_${'C'.repeat(43)}`;
    await writeFile(
      join(dir, '.env'),
      `DISCORD_TOKEN=abc\nSHARDLENS_URL=https://stats.example.com\nSHARDLENS_INGEST_KEY="${key}"\n`,
    );
    expect(await readBotEnv(dir)).toEqual({ file: join(dir, '.env'), url: 'https://stats.example.com', key });
    expect(process.env.SHARDLENS_INGEST_KEY).not.toBe(key);
    await writeFile(join(dir, '.env'), 'SHARDLENS_URL=\n');
    expect(await readBotEnv(dir)).toEqual({ file: join(dir, '.env') });
  });
});

describe('doctor', () => {
  it('checks the collector and key without sending the key anywhere else', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      if (String(input).endsWith('/healthz')) return Response.json({ ok: true });
      return Response.json({ appId: '1234567890123456789', mode: 'privacy', saltPeriod: 'month', salts: [{}] });
    }) as typeof fetch;
    const checks = await doctor({ url: 'https://stats.example.com', key: `slk_ingest_${'A'.repeat(43)}`, fetchImpl });
    expect(checks.filter((c) => !c.ok && !c.warnOnly)).toEqual([]);
    expect(urls.every((u) => u.startsWith('https://stats.example.com/'))).toBe(true);
  });

  it('flags plain HTTP to a remote collector', async () => {
    const checks = await doctor({
      url: 'http://stats.example.com',
      fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
    });
    expect(checks.find((c) => c.name === 'Collector URL')?.ok).toBe(false);
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

    const found = (await doctor({ cwd: nested })).find((c) => c.name === 'discord.js');
    expect(found).toMatchObject({ ok: true, detail: '15.0.0' });
  });

  it('passes the discord.js check for an HTTP-interactions bot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shardlens-doctor-'));
    dirs.push(dir);
    const http = join(dir, 'node_modules', '@shardlens', 'http');
    await mkdir(http, { recursive: true });
    await writeFile(join(http, 'package.json'), JSON.stringify({ name: '@shardlens/http', version: '0.1.0' }));
    const found = (await doctor({ cwd: dir })).find((c) => c.name === 'discord.js');
    expect(found).toMatchObject({ ok: true });
    expect(found?.detail).toContain('@shardlens/http');
  });

  it('warns rather than fails when discord.js is not installed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shardlens-doctor-'));
    dirs.push(dir);
    const found = (await doctor({ cwd: dir })).find((c) => c.name === 'discord.js');
    expect(found).toMatchObject({ ok: false, warnOnly: true });
  });
});
