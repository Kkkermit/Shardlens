import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEnvFile } from './env-file.js';

/** The names bots usually give their MongoDB connection string, in the order they're looked for. */
const MONGODB_VARIABLES = [
  'MONGODB_URI',
  'MONGO_URI',
  'MONGODB_URL',
  'MONGO_URL',
  'MONGODB_CONNECTION_STRING',
  'MONGO_CONNECTION_STRING',
  'DATABASE_URL',
  'DB_URI',
  'DB_URL',
] as const;

const MONGODB_URL = /^mongodb(?:\+srv)?:\/\//i;

/** What the command uses of `@shardlens/collector/mongodb`. */
interface Collector {
  appId: string;
  dashboardUrl: string | undefined;
  signInLink(): string | undefined;
  close(): Promise<void>;
}

export interface CollectorModule {
  startMongoCollector(options: {
    uri: string;
    appId?: string | undefined;
    dashboard: { port: number; host: string };
    logLevel: 'warn';
  }): Promise<Collector>;
}

/** The first MongoDB connection string among the usual variable names, and the name it was found under. */
export function findMongoUri(env: Record<string, string | undefined>): { name: string; uri: string } | undefined {
  for (const name of MONGODB_VARIABLES) {
    const uri = env[name]?.trim();
    if (uri && MONGODB_URL.test(uri)) return { name, uri };
  }
  return undefined;
}

/**
 * The collector installed in the bot's project (`npm install @shardlens/collector` for the `mongodb` option), found
 * from `cwd` the way the bot's own imports find it, rather than wherever npx put this CLI.
 */
async function loadCollector(cwd: string): Promise<CollectorModule | undefined> {
  let path: string;
  try {
    path = createRequire(join(cwd, 'package.json')).resolve('@shardlens/collector/mongodb');
  } catch {
    return undefined;
  }
  return (await import(pathToFileURL(path).href)) as CollectorModule;
}

export interface DashboardOptions {
  uri?: string | undefined;
  appId?: string | undefined;
  port?: number | undefined;
  /** The bot's folder: its `.env`, and where `@shardlens/collector` is installed. */
  cwd: string;
  /** Variables already set: they win over `.env`. */
  env: Record<string, string | undefined>;
  /** Resolves when the dashboard should stop (Ctrl+C). */
  until: Promise<unknown>;
  /** Called with each line to print. */
  print: (line: string) => void;
  /** For tests. */
  load?: ((cwd: string) => Promise<CollectorModule | undefined>) | undefined;
}

/**
 * `shardlens dashboard`: the dashboard of a bot that keeps its data in its own MongoDB, served on this machine only
 * (127.0.0.1) until stopped, with a one-time link that signs you in as the owner. Exit codes: 0 stopped, 1 failed.
 */
export async function dashboard(options: DashboardOptions): Promise<number> {
  const file = join(options.cwd, '.env');
  const found = options.uri
    ? { name: '--uri', uri: options.uri }
    : (findMongoUri(options.env) ?? findMongoUri((await readEnvFile(file)) ?? {}));
  if (!found) {
    options.print(
      `No MongoDB connection string found: looked for ${MONGODB_VARIABLES.join(', ')} in the environment and in ${file}. ` +
        "Pass it with --uri, or run this in your bot's folder.",
    );
    return 1;
  }
  if (!MONGODB_URL.test(found.uri)) {
    options.print('--uri must be a mongodb:// or mongodb+srv:// connection string.');
    return 1;
  }
  const module = await (options.load ?? loadCollector)(options.cwd);
  if (!module) {
    options.print(
      "The dashboard runs from @shardlens/collector, which is not installed here. In your bot's folder:\n" +
        '  npm install @shardlens/collector\n' +
        'then run npx shardlens dashboard there.',
    );
    return 1;
  }
  const port = options.port ?? 8080;
  const collector = await module.startMongoCollector({
    uri: found.uri,
    appId: options.appId,
    dashboard: { port, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  try {
    const link = collector.signInLink();
    if (!collector.dashboardUrl || !link) {
      options.print(`Port ${port} is already in use (is your bot serving the dashboard?). Pass another with --port.`);
      return 1;
    }
    options.print(`Shardlens dashboard for application ${collector.appId}, from the MongoDB in ${found.name}.`);
    options.print('');
    options.print(`  Open ${link}`);
    options.print('  (signs you in once, within 15 minutes; only this machine can open it)');
    options.print('');
    options.print('Press Ctrl+C to stop.');
    await options.until;
    return 0;
  } finally {
    await collector.close();
  }
}
