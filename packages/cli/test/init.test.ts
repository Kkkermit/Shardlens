import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { init, UsageError } from '../src/init.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shardlens-init-'));
  dirs.push(dir);
  return dir;
}

const options = { domain: 'stats.example.com', appId: '1234567890123456789' };
const env = async (dir: string, file = '.env') => parseEnv(await readFile(join(dir, file), 'utf8'));
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const posix = process.platform !== 'win32';

describe('init', () => {
  it('writes the deployment files, with fresh secrets the collector accepts', async () => {
    const dir = await tempDir();
    const result = await init({ ...options, dir });
    expect(result).toEqual({
      dir,
      url: 'https://stats.example.com',
      written: ['docker-compose.yml', 'Caddyfile', '.env', 'bot.env'],
      dashboard: 'shardlens',
      audit: false,
    });
    const text = await readFile(join(dir, '.env'), 'utf8');
    expect(text).toMatch(/^SHARDLENS_INGEST_KEY=slk_ingest_[\w-]{43}$/m);
    expect(text).toMatch(/^SHARDLENS_READ_KEY=slk_read_[\w-]{43}$/m);
    expect(text).toMatch(/^SHARDLENS_SETTINGS_KEY=.{44}$/m);
    expect(text).toMatch(/^SHARDLENS_SESSION_SECRET=.{44}$/m);
    expect(text).toMatch(/^POSTGRES_PASSWORD=[\w-]{32}$/m);
    expect(text).toContain('SHARDLENS_PUBLIC_URL=https://stats.example.com');
    expect(await readFile(join(dir, 'docker-compose.yml'), 'utf8')).toContain('postgres:');
    if (posix) expect(await mode(join(dir, '.env'))).toBe(0o600);
  });

  it('puts exactly what the bot needs in bot.env, readable by its owner only', async () => {
    const dir = await tempDir();
    await init({ ...options, dir });
    const bot = await env(dir, 'bot.env');
    expect(bot).toEqual({
      SHARDLENS_URL: 'https://stats.example.com',
      SHARDLENS_INGEST_KEY: (await env(dir)).SHARDLENS_INGEST_KEY,
    });
    if (posix) expect(await mode(join(dir, 'bot.env'))).toBe(0o600);
  });

  it('refuses to replace any file already there, such as a project’s own docker-compose.yml', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  bot:\n    image: my-bot\n');
    await expect(init({ ...options, dir })).rejects.toThrow(
      `${dir} already has docker-compose.yml. Run again with --force`,
    );
    expect(await readFile(join(dir, 'docker-compose.yml'), 'utf8')).toContain('my-bot');

    const again = await tempDir();
    await init({ ...options, dir: again });
    await expect(init({ ...options, dir: again })).rejects.toThrow(
      'already has docker-compose.yml, Caddyfile, .env and bot.env',
    );
  });

  it('keeps the secrets and settings of an existing .env with --force, so a running collector keeps its data', async () => {
    const dir = await tempDir();
    await init({ ...options, dir });
    const before = await env(dir);
    const text = await readFile(join(dir, '.env'), 'utf8');
    await writeFile(
      join(dir, '.env'),
      `${text.replace('DISCORD_PUBLIC_KEY=', `DISCORD_PUBLIC_KEY=${'a'.repeat(64)}`)}SHARDLENS_EXTRA_ADMINS='111111111111111111'\n`,
    );

    const result = await init({ ...options, dir, domain: 'Analytics.Example.com', force: true });
    expect(result.written).toEqual(['docker-compose.yml', 'Caddyfile', 'bot.env']);
    expect(result.updated).toEqual(['SHARDLENS_DOMAIN', 'SHARDLENS_PUBLIC_URL']);
    const after = await env(dir);
    for (const name of [
      'POSTGRES_PASSWORD',
      'SHARDLENS_SESSION_SECRET',
      'SHARDLENS_SETTINGS_KEY',
      'SHARDLENS_INGEST_KEY',
      'SHARDLENS_READ_KEY',
    ]) {
      expect(after[name], name).toBe(before[name]);
    }
    expect(after).toMatchObject({
      SHARDLENS_DOMAIN: 'analytics.example.com',
      SHARDLENS_PUBLIC_URL: 'https://analytics.example.com',
      DISCORD_PUBLIC_KEY: 'a'.repeat(64),
      SHARDLENS_EXTRA_ADMINS: '111111111111111111',
    });
    const updated = await readFile(join(dir, '.env'), 'utf8');
    expect(updated).toContain("SHARDLENS_EXTRA_ADMINS='111111111111111111'");
    expect(updated).toContain('# Optional: "Sign in with Discord".');
    expect(await env(dir, 'bot.env')).toEqual({
      SHARDLENS_URL: 'https://analytics.example.com',
      SHARDLENS_INGEST_KEY: before.SHARDLENS_INGEST_KEY,
    });

    expect((await init({ ...options, dir, domain: 'analytics.example.com', force: true })).updated).toEqual([]);
  });

  it('fills in missing secrets of an existing .env with --force', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env'), '# from .env.example\nSHARDLENS_APP_ID=\nPOSTGRES_PASSWORD=\nLOG_LEVEL=debug\n');
    const result = await init({ ...options, dir, force: true });
    expect(result.updated).toEqual([
      'SHARDLENS_DOMAIN',
      'SHARDLENS_PUBLIC_URL',
      'SHARDLENS_APP_ID',
      'POSTGRES_PASSWORD',
      'SHARDLENS_SESSION_SECRET',
      'SHARDLENS_SETTINGS_KEY',
      'SHARDLENS_INGEST_KEY',
      'SHARDLENS_READ_KEY',
    ]);
    const after = await env(dir);
    expect(after.POSTGRES_PASSWORD).toMatch(/^[\w-]{32}$/);
    expect(after.SHARDLENS_INGEST_KEY).toMatch(/^slk_ingest_[\w-]{43}$/);
    expect(after.LOG_LEVEL).toBe('debug');
    expect(await env(dir, 'bot.env')).toMatchObject({ SHARDLENS_INGEST_KEY: after.SHARDLENS_INGEST_KEY });
  });

  it('creates new API keys for a new application ID, keeping the database password and encryption keys', async () => {
    const dir = await tempDir();
    await init({ ...options, dir });
    const before = await env(dir);
    const result = await init({ ...options, dir, appId: '9876543210987654321', force: true });
    expect(result.updated).toEqual(['SHARDLENS_APP_ID', 'SHARDLENS_INGEST_KEY', 'SHARDLENS_READ_KEY']);
    const after = await env(dir);
    expect(after.SHARDLENS_INGEST_KEY).not.toBe(before.SHARDLENS_INGEST_KEY);
    expect(after.POSTGRES_PASSWORD).toBe(before.POSTGRES_PASSWORD);
    expect(after.SHARDLENS_SETTINGS_KEY).toBe(before.SHARDLENS_SETTINGS_KEY);
  });

  it('turns on the audit key with --force --identify-users, and never drops one in use', async () => {
    const dir = await tempDir();
    await init({ ...options, dir });
    expect((await env(dir)).SHARDLENS_AUDIT_KEY).toBeUndefined();
    await init({ ...options, dir, force: true, identifyUsers: true });
    const text = await readFile(join(dir, '.env'), 'utf8');
    expect(text).toMatch(/^SHARDLENS_AUDIT_KEY=.{44}$/m);
    expect(text).not.toContain('# SHARDLENS_AUDIT_KEY');
    const auditKey = (await env(dir)).SHARDLENS_AUDIT_KEY;
    await init({ ...options, dir, force: true });
    expect((await env(dir)).SHARDLENS_AUDIT_KEY).toBe(auditKey);
  });

  it('makes replaced secret files private again with --force', async () => {
    if (!posix) return;
    const dir = await tempDir();
    await init({ ...options, dir });
    await chmod(join(dir, '.env'), 0o644);
    await chmod(join(dir, 'bot.env'), 0o644);
    await init({ ...options, dir, force: true });
    for (const file of ['.env', 'bot.env']) expect(await mode(join(dir, file)), file).toBe(0o600);
  });

  it('leaves the audit key commented out unless identified users were asked for', async () => {
    const hashed = await tempDir();
    const identified = await tempDir();
    await init({ ...options, dir: hashed });
    await init({ ...options, dir: identified, identifyUsers: true });
    expect(await readFile(join(hashed, '.env'), 'utf8')).toMatch(/^# SHARDLENS_AUDIT_KEY=.{44}$/m);
    expect(await readFile(join(identified, '.env'), 'utf8')).toMatch(/^SHARDLENS_AUDIT_KEY=.{44}$/m);
  });

  it('sets the collector up for the Shardlens dashboard unless another choice is made', async () => {
    const dir = await tempDir();
    const result = await init({ ...options, dir });
    expect(result.dashboard).toBe('shardlens');
    expect((await env(dir)).SHARDLENS_DASHBOARD).toBe('on');
    expect(existsSync(join(dir, 'dashboard.env'))).toBe(false);
  });

  it('turns the dashboard off for a dashboard of your own, and writes what its server needs', async () => {
    const dir = await tempDir();
    const result = await init({ ...options, dir, dashboard: 'own' });
    expect(result).toMatchObject({ dashboard: 'own', written: expect.arrayContaining(['dashboard.env']) });
    const settings = await env(dir);
    expect(settings.SHARDLENS_DASHBOARD).toBe('off');
    // Hashed users: nothing identifies anyone, so there is no key that reads who ran what.
    expect(settings).not.toHaveProperty('SHARDLENS_MODE');
    expect(settings).not.toHaveProperty('SHARDLENS_ACTIVITY_KEY');
    expect(await env(dir, 'dashboard.env')).toEqual({
      SHARDLENS_URL: 'https://stats.example.com',
      SHARDLENS_READ_KEY: settings.SHARDLENS_READ_KEY,
    });
    if (posix) expect(await mode(join(dir, 'dashboard.env'))).toBe(0o600);
    await expect(init({ ...options, dir, dashboard: 'own' })).rejects.toThrow(/dashboard\.env/);
  });

  it('chooses identified users in .env when there is no Settings page, with a key to read them', async () => {
    const own = await tempDir();
    await init({ ...options, dir: own, dashboard: 'own', identifyUsers: true });
    const settings = await env(own);
    expect(settings).toMatchObject({ SHARDLENS_DASHBOARD: 'off', SHARDLENS_MODE: 'audit' });
    expect(Buffer.from(settings.SHARDLENS_AUDIT_KEY ?? '', 'base64')).toHaveLength(32);
    expect(settings.SHARDLENS_ACTIVITY_KEY).toMatch(/^slk_activity_[\w-]{43}$/);
    expect((await env(own, 'dashboard.env')).SHARDLENS_ACTIVITY_KEY).toBe(settings.SHARDLENS_ACTIVITY_KEY);

    const none = await tempDir();
    const result = await init({ ...options, dir: none, dashboard: 'none', identifyUsers: true });
    expect(result.dashboard).toBe('none');
    expect(existsSync(join(none, 'dashboard.env'))).toBe(false);
    expect(await env(none)).toMatchObject({
      SHARDLENS_DASHBOARD: 'off',
      SHARDLENS_MODE: 'audit',
    });

    // With the Shardlens dashboard, the switch stays in Settings, behind a Discord sign-in.
    const shardlens = await tempDir();
    await init({ ...options, dir: shardlens, identifyUsers: true });
    const usual = await env(shardlens);
    expect(usual).not.toHaveProperty('SHARDLENS_MODE');
    expect(usual).not.toHaveProperty('SHARDLENS_ACTIVITY_KEY');
  });

  it('changes the dashboard choice of an existing .env only when asked', async () => {
    const dir = await tempDir();
    await init({ ...options, dir, dashboard: 'none' });
    // Running init again without the option must not bring the dashboard back.
    const again = await init({ ...options, dir, force: true });
    expect(again).toMatchObject({ updated: [], dashboard: 'none' });
    expect((await env(dir)).SHARDLENS_DASHBOARD).toBe('off');

    const identified = await init({ ...options, dir, force: true, identifyUsers: true });
    expect(identified.updated).toEqual(['SHARDLENS_AUDIT_KEY', 'SHARDLENS_MODE', 'SHARDLENS_ACTIVITY_KEY']);
    const activityKey = (await env(dir)).SHARDLENS_ACTIVITY_KEY;

    const back = await init({ ...options, dir, force: true, dashboard: 'shardlens' });
    expect(back).toMatchObject({ updated: ['SHARDLENS_DASHBOARD'], dashboard: 'shardlens' });
    const settings = await env(dir);
    expect(settings).toMatchObject({ SHARDLENS_DASHBOARD: 'on', SHARDLENS_ACTIVITY_KEY: activityKey });

    // A new application gets a new activity key with its other API keys.
    const moved = await init({ ...options, dir, appId: '9876543210987654321', force: true });
    expect(moved.updated).toContain('SHARDLENS_ACTIVITY_KEY');
    expect((await env(dir)).SHARDLENS_ACTIVITY_KEY).not.toBe(activityKey);
  });

  it('validates the domain and application ID as usage errors', async () => {
    for (const domain of [
      'not a host',
      'stats',
      '-stats.example.com',
      'stats..example.com',
      'stats.example.com:8443',
    ]) {
      await expect(init({ ...options, dir: 'x', domain }), domain).rejects.toThrow(/^--domain must be a hostname/);
    }
    await expect(init({ ...options, dir: 'x', domain: 'https://stats.example.com' })).rejects.toThrow(
      '--domain takes a hostname without https://',
    );
    await expect(init({ ...options, dir: 'x', appId: 'abc' })).rejects.toThrow(UsageError);
  });

  it('names the path and the reason when it cannot write, instead of a bare error code', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a-file');
    await writeFile(file, '');
    await expect(init({ ...options, dir: file })).rejects.toThrow(
      `${file}: a file is in the way of the folder (EEXIST)`,
    );
  });
});
