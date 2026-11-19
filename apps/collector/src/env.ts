import { Snowflake } from '@shardlens/schema';
import { z } from 'zod';
import { DEFAULT_SINK_TABLE, SINK_TABLE, SINK_URL, type SinkSettings } from './storage/sink.js';

const snowflake = Snowflake.describe('a Discord snowflake');
const key32 = z
  .string()
  .refine((s) => Buffer.from(s, 'base64').length === 32, 'must be 32 random bytes, base64 (openssl rand -base64 32)');

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SHARDLENS_PUBLIC_URL: z.url(),
  SHARDLENS_APP_ID: snowflake,
  SHARDLENS_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SHARDLENS_SETTINGS_KEY: key32,
  SHARDLENS_AUDIT_KEY: key32.optional(),
  DISCORD_CLIENT_ID: snowflake.optional(),
  DISCORD_CLIENT_SECRET: z.string().min(16).optional(),
  DISCORD_PUBLIC_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
  SHARDLENS_INGEST_KEY: z
    .string()
    .regex(/^slk_ingest_[\w-]{43}$/, 'must be an slk_ingest_ key')
    .optional(),
  SHARDLENS_READ_KEY: z
    .string()
    .regex(/^slk_read_[\w-]{43}$/, 'must be an slk_read_ key')
    .optional(),
  SHARDLENS_ACTIVITY_KEY: z
    .string()
    .regex(/^slk_activity_[\w-]{43}$/, 'must be an slk_activity_ key')
    .optional(),
  SHARDLENS_MODE: z.enum(['privacy', 'audit']).optional(),
  SHARDLENS_DASHBOARD: z.enum(['on', 'off']).default('on'),
  SHARDLENS_EXTRA_ADMINS: z.string().optional(),
  SHARDLENS_TRUST_PROXY: z
    .string()
    .regex(/^(true|false|[1-9])$/, 'must be false, a number of proxies in front (1 for one), or true')
    .default('false'),
  SHARDLENS_DEMO: z.enum(['true', 'false']).default('false'),
  CLICKHOUSE_URL: z.url().optional(),
  SHARDLENS_SINK_URL: z
    .string()
    .regex(SINK_URL, 'must start with mongodb:, mongodb+srv:, mysql:, mariadb:, postgres: or sqlite:')
    .optional(),
  SHARDLENS_SINK_TABLE: z
    .string()
    .regex(SINK_TABLE, 'must be letters, digits and underscores')
    .default(DEFAULT_SINK_TABLE),
  SHARDLENS_SINK_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(35),
  SHARDLENS_SINK_EVENTS: z
    .string()
    .regex(/^[a-z_]+(\s*,\s*[a-z_]+)*$/, 'must be a comma-separated list of event types')
    .optional(),
  SHARDLENS_DASHBOARD_DIR: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Every variable the collector reads (the docs' environment reference is checked against this list). */
export const ENV_VARIABLES: readonly string[] = Object.keys(EnvSchema.shape);

export interface Config {
  databaseUrl: string;
  publicUrl: URL;
  appId: string;
  sessionSecret: string;
  settingsKey: string;
  auditKey: string | undefined;
  discord: { clientId: string; clientSecret: string } | undefined;
  discordPublicKey: string | undefined;
  ingestKey: string | undefined;
  readKey: string | undefined;
  /** Reads who ran what (audit mode) for a dashboard of the owner's own. */
  activityKey?: string | undefined;
  /**
   * Hashed or identified users, decided here instead of in Settings: the only way to choose when the dashboard is
   * off. `undefined` leaves the choice to Settings.
   */
  mode?: 'privacy' | 'audit' | undefined;
  /** Serve the dashboard pages. Off, the collector is an API only: for people who use their own dashboard or none. */
  dashboard: boolean;
  extraAdmins: string[];
  /**
   * Proxies in front whose `X-Forwarded-For` entries are believed: a count trusts that many hops from the right, `true`
   * trusts the whole header (safe only behind a proxy that replaces it).
   */
  trustProxy: boolean | number;
  /** Public demo: anyone may view the dashboard read-only. Never for real data. */
  demo: boolean;
  /** Optional ClickHouse analytics store (preview). Never logged: it may contain credentials. */
  clickhouseUrl?: string | undefined;
  /** Optional copy of every accepted event in the owner's own database. Never logged: the URL may hold a password. */
  sink?: SinkSettings | undefined;
  dashboardDir: string | undefined;
  port: number;
  host: string;
  logLevel: string;
}

/**
 * Reads collector configuration from the environment. Refuses to start (throws) when a required setting is missing or
 * too short; the error names the variables but never prints their values.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Empty values (unused optional settings in an .env file) count as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid collector configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  if ((e.DISCORD_CLIENT_ID === undefined) !== (e.DISCORD_CLIENT_SECRET === undefined)) {
    throw new Error(
      'Invalid collector configuration: set both DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, or neither',
    );
  }
  if (e.SHARDLENS_MODE === 'audit' && e.SHARDLENS_AUDIT_KEY === undefined) {
    throw new Error('Invalid collector configuration: SHARDLENS_MODE=audit needs SHARDLENS_AUDIT_KEY');
  }
  const extraAdmins = (e.SHARDLENS_EXTRA_ADMINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of extraAdmins) {
    if (!/^\d{17,20}$/.test(id)) throw new Error('Invalid collector configuration: SHARDLENS_EXTRA_ADMINS must be IDs');
  }
  return {
    databaseUrl: e.DATABASE_URL,
    publicUrl: new URL(e.SHARDLENS_PUBLIC_URL),
    appId: e.SHARDLENS_APP_ID,
    sessionSecret: e.SHARDLENS_SESSION_SECRET,
    settingsKey: e.SHARDLENS_SETTINGS_KEY,
    auditKey: e.SHARDLENS_AUDIT_KEY,
    discord:
      e.DISCORD_CLIENT_ID && e.DISCORD_CLIENT_SECRET
        ? { clientId: e.DISCORD_CLIENT_ID, clientSecret: e.DISCORD_CLIENT_SECRET }
        : undefined,
    discordPublicKey: e.DISCORD_PUBLIC_KEY,
    ingestKey: e.SHARDLENS_INGEST_KEY,
    readKey: e.SHARDLENS_READ_KEY,
    activityKey: e.SHARDLENS_ACTIVITY_KEY,
    mode: e.SHARDLENS_MODE,
    dashboard: e.SHARDLENS_DASHBOARD === 'on',
    extraAdmins,
    trustProxy:
      e.SHARDLENS_TRUST_PROXY === 'true'
        ? true
        : e.SHARDLENS_TRUST_PROXY === 'false'
          ? false
          : Number(e.SHARDLENS_TRUST_PROXY),
    demo: e.SHARDLENS_DEMO === 'true',
    clickhouseUrl: e.CLICKHOUSE_URL,
    sink: e.SHARDLENS_SINK_URL
      ? {
          to: e.SHARDLENS_SINK_URL,
          table: e.SHARDLENS_SINK_TABLE,
          retentionDays: e.SHARDLENS_SINK_RETENTION_DAYS,
          events: e.SHARDLENS_SINK_EVENTS?.split(',').map((t) => t.trim()),
        }
      : undefined,
    dashboardDir: e.SHARDLENS_DASHBOARD_DIR,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
  };
}

/** Where the dashboard is, for links in alerts and reports: nowhere when the collector doesn't serve it. */
export function dashboardUrl(config: Config): URL | undefined {
  return config.dashboard ? config.publicUrl : undefined;
}
