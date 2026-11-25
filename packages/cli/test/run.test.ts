import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { run } from '../src/run.js';

let out: MockInstance<typeof console.log>;
let err: MockInstance<typeof console.error>;
const printed = () => out.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => err.mock.calls.map((c) => String(c[0])).join('\n');

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shardlens-run-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const initArgs = ['--domain', 'stats.example.com', '--app-id', '1234567890123456789'];

describe('command line', () => {
  it('prints help for --help wherever it is, and for no command at all', async () => {
    for (const argv of [['--help'], ['-h'], ['init', '--help'], ['help'], []]) {
      out.mockClear();
      expect(await run(argv)).toBe(0);
      expect(printed()).toContain('Usage: shardlens <command> [options]');
    }
    expect(err).not.toHaveBeenCalled();
  });

  it('lists every option the commands accept in the help', async () => {
    await run(['--help']);
    for (const option of [
      '--domain',
      '--app-id',
      '--dir',
      '--identify-users',
      '--dashboard',
      '--force',
      '--scope',
      '--audit',
      '--ids-only',
      '--option-values',
      '--webhook-events',
      '--retention',
      '--audit-retention',
      '--url',
      '--key',
      '--version',
    ]) {
      expect(printed()).toContain(option);
    }
  });

  it('prints its version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    for (const flag of ['--version', '-v']) {
      out.mockClear();
      expect(await run([flag])).toBe(0);
      expect(printed()).toBe(pkg.version);
    }
  });

  it('refuses wrong usage with exit code 2 and a short message', async () => {
    const cases: [string[], string][] = [
      [['deploy'], 'Unknown command "deploy".'],
      [['keys', 'read'], 'Unexpected argument "read".'],
      [['init', '--domian', 'stats.example.com'], 'Unknown option --domian.'],
      [['keys', '--domain', 'stats.example.com'], 'keys has no --domain option.'],
      [['init', '--domain'], "Option '--domain <value>' argument missing"],
      [['init', '--domain', 'stats.example.com'], 'init needs --app-id.'],
      [['init'], 'init needs --domain and --app-id.'],
      [
        ['init', '--domain', 'https://stats.example.com', '--app-id', '1234567890123456789'],
        '--domain takes a hostname',
      ],
      [['keys', '--scope', 'admin'], '--scope must be ingest, read or activity.'],
      [['init', ...initArgs, '--dashboard', 'mine'], '--dashboard must be shardlens, own or none.'],
    ];
    for (const [argv, message] of cases) {
      err.mockClear();
      expect(await run(argv), argv.join(' ')).toBe(2);
      expect(errors()).toContain(message);
      expect(errors()).toContain('Run "shardlens --help"');
      expect(errors()).not.toContain('positional argument');
    }
    expect(out).not.toHaveBeenCalled();
  });

  it('points a bare init at the MongoDB setup, which needs none', async () => {
    expect(await run(['init'])).toBe(2);
    expect(errors()).toContain('Bot on MongoDB? It needs no init');
    err.mockClear();
    expect(await run(['init', '--domain', 'stats.example.com'])).toBe(2);
    expect(errors()).not.toContain('MongoDB');
  });
});

describe('init', () => {
  it('prints the next steps, with a folder with spaces quoted in the command to paste', async () => {
    const dir = join(await tempDir(), "my bot's stats");
    expect(await run(['init', '--dir', dir, ...initArgs])).toBe(0);
    expect(printed()).toContain(`Wrote docker-compose.yml, Caddyfile, .env and bot.env to ${dir}`);
    expect(printed()).toContain(`cd '${dir.replaceAll("'", "'\\''")}' && docker compose up -d`);
    expect(printed()).toContain('Copy the two lines in bot.env');
    expect(printed()).toContain('Open https://stats.example.com');
  });

  it('ends with where the numbers are looked at, for each dashboard choice', async () => {
    const own = await tempDir();
    expect(await run(['init', '--dir', own, ...initArgs, '--dashboard', 'own'])).toBe(0);
    expect(printed()).toContain(`Wrote docker-compose.yml, Caddyfile, .env, bot.env and dashboard.env to ${own}`);
    expect(printed()).toContain('Copy the lines in dashboard.env');
    expect(printed()).toContain('npm install @shardlens/client');
    expect(printed()).not.toContain('Open https://stats.example.com');
    out.mockClear();
    expect(await run(['init', '--dir', await tempDir(), ...initArgs, '--dashboard', 'none'])).toBe(0);
    expect(printed()).toContain('There is no dashboard to open');
    expect(printed()).not.toContain('dashboard.env');
  });

  it('says the bot has to be switched to audit mode when .env switches the collector', async () => {
    expect(await run(['init', '--dir', await tempDir(), ...initArgs, '--dashboard', 'own', '--identify-users'])).toBe(
      0,
    );
    expect(printed()).toContain("give createShardlens mode: 'audit' in your bot too");
    out.mockClear();
    // With the Shardlens dashboard, audit mode is still off until it is chosen in Settings.
    expect(await run(['init', '--dir', await tempDir(), ...initArgs, '--identify-users'])).toBe(0);
    expect(printed()).not.toContain("mode: 'audit'");
  });

  it('says what --force changed in an existing .env', async () => {
    const dir = await tempDir();
    await run(['init', '--dir', dir, ...initArgs]);
    out.mockClear();
    expect(await run(['init', '--dir', dir, ...initArgs])).toBe(1);
    expect(errors()).toContain('already has docker-compose.yml, Caddyfile, .env and bot.env');
    expect(await run(['init', '--dir', dir, '--force', ...initArgs])).toBe(0);
    expect(printed()).toContain('Wrote docker-compose.yml, Caddyfile and bot.env');
    expect(printed()).toContain('Kept the existing .env as it was.');
    out.mockClear();
    await run(['init', '--dir', dir, '--force', '--domain', 'stats2.example.com', '--app-id', '1234567890123456789']);
    expect(printed()).toContain('Set SHARDLENS_DOMAIN and SHARDLENS_PUBLIC_URL in the existing .env');
  });
});

describe('keys', () => {
  it('prints only the key on standard output, in the format the collector accepts', async () => {
    expect(await run(['keys'])).toBe(0);
    expect(printed()).toMatch(/^slk_ingest_[\w-]{43}$/);
    out.mockClear();
    expect(await run(['keys', '--scope', 'read'])).toBe(0);
    expect(printed()).toMatch(/^slk_read_[\w-]{43}$/);
    expect(errors()).toContain('SHARDLENS_READ_KEY');
    out.mockClear();
    expect(await run(['keys', '--scope', 'activity'])).toBe(0);
    expect(printed()).toMatch(/^slk_activity_[\w-]{43}$/);
    expect(errors()).toContain('SHARDLENS_ACTIVITY_KEY');
  });
});

describe('privacy', () => {
  it('refuses a retention that is not a whole number of days rather than printing the default', async () => {
    for (const retention of ['abc', '0', '-5', '7.5', '400', '1e3', '6', '']) {
      expect(await run(['privacy', `--retention=${retention}`]), retention).toBe(2);
    }
    expect(await run(['privacy', '--audit', '--audit-retention=91'])).toBe(2);
    expect(out).not.toHaveBeenCalled();
    expect(errors()).toContain('--retention must be a whole number of days from 7 to 90');
    expect(await run(['privacy', '--retention', '60'])).toBe(0);
    expect(printed()).toContain('kept for 60 days');
    out.mockClear();
    expect(await run(['privacy', '--audit-retention', '90'])).toBe(0);
    expect(printed()).toContain('for up to 90 days');
  });
});

describe('doctor', () => {
  it("uses the collector's address and key from a .env in the current folder, and says so", async () => {
    const dir = await tempDir();
    const key = `slk_ingest_${'B'.repeat(43)}`;
    await writeFile(join(dir, '.env'), `SHARDLENS_PUBLIC_URL=https://stats.example.com\nSHARDLENS_INGEST_KEY=${key}\n`);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('SHARDLENS_URL', '');
    vi.stubEnv('SHARDLENS_INGEST_KEY', '');
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: URL, init?: RequestInit) => {
      seen.push(`${input.href} ${new Headers(init?.headers).get('authorization') ?? '-'}`);
      return input.pathname === '/healthz'
        ? Response.json({ ok: true })
        : Response.json({ appId: '1234567890123456789', mode: 'privacy', saltPeriod: 'month', salts: [{}] });
    });
    expect(await run(['doctor'])).toBe(0);
    expect(printed()).toContain(`Using SHARDLENS_PUBLIC_URL and SHARDLENS_INGEST_KEY from ${join(dir, '.env')}`);
    expect(seen).toEqual(['https://stats.example.com/healthz -', `https://stats.example.com/v1/config Bearer ${key}`]);
    expect(printed()).not.toContain(key);
  });

  it('says when it cannot read the .env in the current folder, instead of ignoring it', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.env'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('SHARDLENS_URL', '');
    vi.stubEnv('SHARDLENS_INGEST_KEY', '');
    expect(await run(['doctor'])).toBe(0);
    expect(printed()).toContain(`Could not read ${join(dir, '.env')} (EISDIR)`);
  });

  it('exits with 1 when a check fails', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(await tempDir());
    expect(await run(['doctor', '--url', 'http://stats.example.com'])).toBe(1);
    expect(printed()).toContain('✗ Collector URL: http://stats.example.com must be HTTPS');
  });
});
