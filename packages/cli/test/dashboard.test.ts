import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CollectorModule, dashboard, findMongoUri } from '../src/dashboard.js';
import { run } from '../src/run.js';

const URI = 'mongodb+srv://bot:secret@cluster0.example.mongodb.net/mybot';
const APP_ID = '123456789012345678';

/** A collector module that records how it was started. */
function fakeCollector(opts: { busy?: boolean } = {}) {
  const starts: Parameters<CollectorModule['startMongoCollector']>[0][] = [];
  const close = vi.fn(async () => undefined);
  const module: CollectorModule = {
    async startMongoCollector(options) {
      starts.push(options);
      const url = opts.busy ? undefined : `http://localhost:${options.dashboard.port}`;
      return {
        appId: options.appId ?? APP_ID,
        dashboardUrl: url,
        signInLink: () => (url ? `${url}/auth/link/token` : undefined),
        close,
      };
    },
  };
  return { module, starts, close };
}

describe('findMongoUri', () => {
  it('takes the first MongoDB connection string among the usual names', () => {
    expect(findMongoUri({ MONGO_URL: URI })).toEqual({ name: 'MONGO_URL', uri: URI });
    expect(findMongoUri({ DATABASE_URL: 'postgres://db/x', MONGO_URI: URI })).toEqual({ name: 'MONGO_URI', uri: URI });
    expect(findMongoUri({ MONGODB_URI: ' ', DATABASE_URL: 'postgres://db/x' })).toBeUndefined();
  });
});

describe('shardlens dashboard', () => {
  let dir: string;
  let lines: string[];
  const print = (line: string) => lines.push(line);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shardlens-dashboard-'));
    lines = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reads the connection string from the bot’s .env, prints a sign-in link and stops when asked', async () => {
    await writeFile(join(dir, '.env'), `DISCORD_TOKEN=x\nMONGODB_URI=${URI}\n`);
    const fake = fakeCollector();
    let stop: () => void = () => undefined;
    const done = dashboard({
      cwd: dir,
      env: {},
      until: new Promise<void>((resolve) => {
        stop = resolve;
      }),
      print,
      load: async () => fake.module,
    });
    await vi.waitFor(() => expect(lines).toContain('Press Ctrl+C to stop.'));
    expect(fake.starts).toEqual([
      { uri: URI, appId: undefined, dashboard: { port: 8080, host: '127.0.0.1' }, logLevel: 'warn' },
    ]);
    expect(lines.join('\n')).toContain('Open http://localhost:8080/auth/link/token');
    expect(lines.join('\n')).toContain(`application ${APP_ID}, from the MongoDB in MONGODB_URI`);
    expect(lines.join('\n')).not.toContain('secret');
    expect(fake.close).not.toHaveBeenCalled();
    stop();
    expect(await done).toBe(0);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('prefers --uri, then the environment, over .env', async () => {
    await writeFile(join(dir, '.env'), 'MONGODB_URI=mongodb://from-file/db\n');
    for (const [options, expected] of [
      [{ uri: URI, env: { MONGODB_URI: 'mongodb://from-env/db' } }, URI],
      [{ env: { MONGO_URI: 'mongodb://from-env/db' } }, 'mongodb://from-env/db'],
    ] as const) {
      const fake = fakeCollector();
      await dashboard({ ...options, cwd: dir, until: Promise.resolve(), print, load: async () => fake.module });
      expect(fake.starts[0]?.uri).toBe(expected);
    }
  });

  it('reads a setting with an unusual name from .env when told its name', async () => {
    await writeFile(join(dir, '.env'), `BOT_DATABASE=${URI}\n`);
    const fake = fakeCollector();
    expect(
      await dashboard({
        envName: 'BOT_DATABASE',
        cwd: dir,
        env: {},
        until: Promise.resolve(),
        print,
        load: async () => fake.module,
      }),
    ).toBe(0);
    expect(fake.starts[0]?.uri).toBe(URI);
    expect(lines.join('\n')).toContain('from the MongoDB in BOT_DATABASE');
    lines = [];
    expect(
      await dashboard({
        envName: 'NOT_THERE',
        cwd: dir,
        env: {},
        until: Promise.resolve(),
        print,
        load: async () => fake.module,
      }),
    ).toBe(1);
    expect(lines.join('\n')).toContain('NOT_THERE is not set');
  });

  it('passes on the database the bot names, for a user allowed into one only', async () => {
    const fake = fakeCollector();
    await dashboard({
      uri: URI,
      database: 'bot_only',
      cwd: dir,
      env: {},
      until: Promise.resolve(),
      print,
      load: async () => fake.module,
    });
    expect(fake.starts[0]?.database).toBe('bot_only');
  });

  it('says where it looked when there is no connection string', async () => {
    const code = await dashboard({ cwd: dir, env: {}, until: Promise.resolve(), print, load: async () => undefined });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/No MongoDB connection string found: looked for MONGODB_URI, MONGO_URI/);
  });

  it('says to install the collector when the bot’s folder has none', async () => {
    // As the real loader finds nothing: it resolves from the folder upwards, as the bot's own imports do.
    const code = await dashboard({
      uri: URI,
      cwd: dir,
      env: {},
      until: Promise.resolve(),
      print,
      load: async () => undefined,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('npm install @shardlens/collector');
  });

  it('fails when the port is taken, and closes what it started', async () => {
    const fake = fakeCollector({ busy: true });
    const code = await dashboard({
      uri: URI,
      port: 9000,
      cwd: dir,
      env: {},
      until: Promise.resolve(),
      print,
      load: async () => fake.module,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Port 9000 is already in use');
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('checks its options before connecting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await run(['dashboard', '--port', '0'])).toBe(2);
      expect(await run(['dashboard', '--app-id', 'mybot'])).toBe(2);
      expect(await run(['dashboard', '--domain', 'x'])).toBe(2);
      expect(await run(['dashboard', '--env', 'not a name'])).toBe(2);
    } finally {
      error.mockRestore();
    }
  });
});
