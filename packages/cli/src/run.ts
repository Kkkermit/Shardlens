import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dashboard } from './dashboard.js';
import { doctor } from './doctor.js';
import { readEnvFile } from './env-file.js';
import { type DashboardChoice, init, isDashboardChoice, UsageError } from './init.js';
import { newKey } from './keys.js';
import { list } from './list.js';
import { privacyParagraph } from './privacy.js';

const HELP = `Usage: shardlens <command> [options]

Set up and check a self-hosted Shardlens collector.

Commands
  init      Write docker-compose.yml, a Caddyfile, a .env with generated secrets and keys, and bot.env with
            the two settings your bot needs
              --domain <host>           the collector's hostname, such as stats.example.com (required)
              --app-id <id>             your Discord application ID (required)
              --dir <path>              where to write the files (default ./shardlens)
              --dashboard <choice>      shardlens (default): the collector serves the Shardlens dashboard
                                        own: no dashboard page; also writes dashboard.env, the settings your own
                                             dashboard's server needs to read the numbers with @shardlens/client
                                        none: no dashboard page; the collector is an API only
              --identify-users          also create SHARDLENS_AUDIT_KEY, for identified users (audit mode); with
                                        own or none it turns audit mode on and creates an activity key to read it
              --force                   replace files already there; an existing .env keeps its secrets
  keys      Print a new API key
              --scope ingest|read|activity
                                        the kind of key (default ingest); an activity key also reads who ran what
  privacy   Print a privacy-policy paragraph that matches your setup
              --audit                   you identify users (audit mode)
              --ids-only                audit mode without usernames and avatars
              --option-values <a,b>     the option names in captureOptionValues
              --webhook-events          you receive Discord webhook events
              --retention <days>        raw-data retention, 7 to 90 (default 35)
              --audit-retention <days>  audit retention, 1 to 90 (default 30)
  dashboard Open the dashboard of a bot that keeps its data in its own MongoDB (the mongodb option), on this
            machine, signed in by a one-time link. Run it in your bot's folder
              --env <name>              the setting that holds the MongoDB connection string, from the
                                        environment or the .env here (default: the first of MONGODB_URI,
                                        MONGO_URI, MONGODB_URL, MONGO_URL, DATABASE_URL and similar names
                                        that holds one)
              --uri <uri>               the connection string itself (it stays in your shell history)
              --database <name>         the database, when the bot's mongodb option names one with database
              --app-id <id>             your Discord application ID, when several bots share the database
              --port <port>             the port to serve it on (default 8080)
  doctor    Check Node.js, discord.js, the collector and your ingest key
              --url <url>               the collector (default SHARDLENS_URL)
              --key <key>               an ingest key (default SHARDLENS_INGEST_KEY)
            Without them it also reads both from a .env in the current folder.

Options
  -h, --help      Show this help
  -v, --version   Print the version

Docs: https://kkkermit.github.io/Shardlens/reference/cli/`;

const OPTIONS = {
  dir: { type: 'string' },
  domain: { type: 'string' },
  'app-id': { type: 'string' },
  force: { type: 'boolean' },
  'identify-users': { type: 'boolean' },
  dashboard: { type: 'string' },
  scope: { type: 'string' },
  audit: { type: 'boolean' },
  'ids-only': { type: 'boolean' },
  'option-values': { type: 'string' },
  'webhook-events': { type: 'boolean' },
  retention: { type: 'string' },
  'audit-retention': { type: 'string' },
  url: { type: 'string' },
  key: { type: 'string' },
  uri: { type: 'string' },
  env: { type: 'string' },
  database: { type: 'string' },
  port: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const parse = (args: string[]) => parseArgs({ args, options: OPTIONS, allowPositionals: true, tokens: true });
type Values = ReturnType<typeof parse>['values'];

const COMMANDS: Record<string, readonly string[]> = {
  init: ['dir', 'domain', 'app-id', 'force', 'identify-users', 'dashboard'],
  keys: ['scope'],
  privacy: ['audit', 'ids-only', 'option-values', 'webhook-events', 'retention', 'audit-retention'],
  doctor: ['url', 'key'],
  dashboard: ['uri', 'env', 'database', 'app-id', 'port'],
};

/** Prints a command-line mistake and returns its exit code. */
function usage(message: string): number {
  console.error(`${message}\nRun "shardlens --help" for the commands and their options.`);
  return 2;
}

/** Runs one invocation of the CLI and returns its exit code: 0 done, 1 failed, 2 wrong usage. */
export async function run(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    if (!(error instanceof Error) || !String((error as NodeJS.ErrnoException).code).startsWith('ERR_PARSE_ARGS')) {
      throw error;
    }
    // Node adds advice about positionals that start with "-", which no command here takes.
    const unknown = /^Unknown option '([^']+)'/.exec(error.message)?.[1];
    return usage(unknown ? `Unknown option ${unknown}.` : error.message);
  }
  const { values, positionals, tokens } = parsed;
  // The command is the first word that isn't an option, so `shardlens --help` and `shardlens init --help` both work.
  const [command, unexpected] = positionals;
  if (values.version) {
    console.log(await version());
    return 0;
  }
  if (!command || values.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  const allowed = COMMANDS[command];
  if (!allowed) return usage(`Unknown command "${command}".`);
  if (unexpected !== undefined) return usage(`Unexpected argument "${unexpected}".`);
  for (const token of tokens) {
    if (token.kind === 'option' && !allowed.includes(token.name)) {
      return usage(`${command} has no ${token.rawName} option.`);
    }
  }
  try {
    switch (command) {
      case 'init':
        return await initCommand(values);
      case 'keys':
        return keysCommand(values.scope);
      case 'privacy':
        return privacyCommand(values);
      case 'dashboard':
        return await dashboardCommand(values);
      default:
        return await doctorCommand(values);
    }
  } catch (error) {
    if (error instanceof UsageError) return usage(error.message);
    if (!(error instanceof Error)) throw error;
    console.error(error.message);
    return 1;
  }
}

async function initCommand(values: Values): Promise<number> {
  const missing = (['domain', 'app-id'] as const).filter((name) => !values[name]).map((name) => `--${name}`);
  if (missing.length > 0) {
    // A bare `init` is often someone looking for the start: with MongoDB there is no server to set up.
    const hint =
      missing.length === 2
        ? `\nBot on MongoDB? It needs no init: createShardlens(client, { mongodb: process.env.MONGODB_URI }), then npx shardlens dashboard (${DOCS}/self-hosting/mongodb/).`
        : '';
    return usage(`init needs ${list(missing)}.${hint}`);
  }
  const dashboard = values.dashboard;
  if (dashboard !== undefined && !isDashboardChoice(dashboard)) {
    return usage('--dashboard must be shardlens, own or none.');
  }
  const result = await init({
    ...(dashboard !== undefined ? { dashboard } : {}),
    dir: values.dir ?? 'shardlens',
    domain: values.domain ?? '',
    appId: values['app-id'] ?? '',
    force: values.force ?? false,
    identifyUsers: values['identify-users'] ?? false,
  });
  console.log(`Wrote ${list(result.written)} to ${result.dir}`);
  if (result.updated) {
    console.log(
      result.updated.length > 0
        ? `Set ${list(result.updated)} in the existing .env and kept everything else in it.`
        : 'Kept the existing .env as it was.',
    );
  }
  console.log(`
Next:
  1. Point DNS for ${new URL(result.url).hostname} at this server, open ports 80 and 443, then start the collector:
       cd ${shellQuote(result.dir)} && docker compose up -d
  2. Copy the two lines in bot.env to where your bot runs, then delete bot.env.${result.audit ? AUDIT_BOT : ''}
  3. Run "npx shardlens doctor" in your bot's folder to check the connection.
  4. ${LOOK[result.dashboard](result.url)}
Keep a copy of .env somewhere safe: without its keys, the collector's encrypted data can't be read.`);
  return 0;
}

const DOCS = 'https://kkkermit.github.io/Shardlens';

// Audit mode is two-sided: until the bot is switched too, it keeps sending hashed users and the log stays empty.
const AUDIT_BOT = `
     The collector records who ran what: give createShardlens mode: 'audit' in your bot too (${DOCS}/guides/audit-mode/).`;

/** The last step of `init`: where the numbers are looked at, for each dashboard choice. */
const LOOK: Record<DashboardChoice, (url: string) => string> = {
  shardlens: (url) => `Open ${url} and sign in with SHARDLENS_READ_KEY from .env.`,
  own: () =>
    `Copy the lines in dashboard.env to your dashboard's server, then delete dashboard.env.
     There, "npm install @shardlens/client" reads every number: ${DOCS}/guides/your-own-dashboard/`,
  none: () =>
    `There is no dashboard to open: the collector is an API only. Read the numbers from a script with
     @shardlens/client and SHARDLENS_READ_KEY, or copy every event into your own database with
     SHARDLENS_SINK_URL: ${DOCS}/getting-started/choose-your-setup/`,
};

async function dashboardCommand(values: Values): Promise<number> {
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65_535)) {
    return usage('--port must be a port number, 1 to 65535.');
  }
  if (values['app-id'] !== undefined && !/^\d{17,20}$/.test(values['app-id'])) {
    return usage('--app-id must be your Discord application ID.');
  }
  if (values.env !== undefined && !/^[A-Za-z_]\w*$/.test(values.env)) {
    return usage('--env takes the name of a setting, such as MY_DATABASE.');
  }
  return dashboard({
    uri: values.uri,
    envName: values.env,
    database: values.database,
    appId: values['app-id'],
    port,
    cwd: process.cwd(),
    env: process.env,
    until: new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    }),
    print: (line) => console.log(line),
  });
}

function keysCommand(scope = 'ingest'): number {
  if (scope !== 'ingest' && scope !== 'read' && scope !== 'activity') {
    return usage('--scope must be ingest, read or activity.');
  }
  console.log(newKey(scope));
  const name = `SHARDLENS_${scope.toUpperCase()}_KEY`;
  console.error(
    `Set it as ${name} in the collector's .env and restart the collector, which stores only its hash. The key it\n` +
      'replaces stops working then. To switch without a gap, create the new key in Settings → API keys instead.',
  );
  return 0;
}

function privacyCommand(values: Values): number {
  // The same limits the collector's settings allow, so the paragraph can't promise what it can't keep.
  const retention = days(values.retention, 7, 90);
  if (retention === null) return usage('--retention must be a whole number of days from 7 to 90.');
  const auditRetention = days(values['audit-retention'], 1, 90);
  if (auditRetention === null) return usage('--audit-retention must be a whole number of days from 1 to 90.');
  const optionValues = (values['option-values'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(
    privacyParagraph({
      audit: values.audit ?? false,
      idsOnly: values['ids-only'] ?? false,
      optionValues,
      webhookEvents: values['webhook-events'] ?? false,
      ...(retention !== undefined ? { retentionDays: retention } : {}),
      ...(auditRetention !== undefined ? { auditRetentionDays: auditRetention } : {}),
    }),
  );
  console.error('\nThis is a starting point, not legal advice: check it against your own bot and obligations.');
  return 0;
}

async function doctorCommand(values: Values): Promise<number> {
  // Run from the bot's folder, its own .env usually holds both settings; in the collector's folder, the collector's
  // .env holds its address and the same ingest key. Options and set variables win, and the environment isn't changed.
  const file = join(process.cwd(), '.env');
  const env = await readEnvFile(file).catch((error: NodeJS.ErrnoException) => {
    console.log(`Could not read ${file} (${error.code ?? error.message}), so only options and variables are used`);
    return undefined;
  });
  const used: string[] = [];
  const pick = (given: string | undefined, variable: string, names: string[]) => {
    if (given) return given;
    if (process.env[variable]) return process.env[variable];
    const name = names.find((n) => env?.[n]);
    if (name) used.push(name);
    return name ? env?.[name] : undefined;
  };
  const url = pick(values.url, 'SHARDLENS_URL', ['SHARDLENS_URL', 'SHARDLENS_PUBLIC_URL']);
  const key = pick(values.key, 'SHARDLENS_INGEST_KEY', ['SHARDLENS_INGEST_KEY']);
  if (used.length > 0) console.log(`Using ${list(used)} from ${file}`);
  const checks = await doctor({ ...(url ? { url } : {}), ...(key ? { key } : {}) });
  for (const c of checks) console.log(`${c.ok ? '✓' : c.warnOnly ? '!' : '✗'} ${c.name}: ${c.detail}`);
  return checks.some((c) => !c.ok && !c.warnOnly) ? 1 : 0;
}

async function version(): Promise<string> {
  // Bundled into dist/index.js, so the package's own package.json is one folder up, as it is from src/.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

/** A whole number of days within the range, `undefined` when not given, `null` when invalid. */
function days(value: string | undefined, min: number, max: number): number | null | undefined {
  if (value === undefined) return undefined;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return n >= min && n <= max ? n : null;
}

/** A path as one shell word, so a pasted command works for a folder with spaces. */
function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}
