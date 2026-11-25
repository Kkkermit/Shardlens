import { ConfigError } from './errors.js';
import type { LogLevel } from './logger.js';

export type Environment = 'development' | 'production' | 'test';

export interface AppConfig {
  readonly env: Environment;
  readonly discord: {
    readonly token: string;
    readonly devGuildId: string | undefined;
    readonly syncCommands: boolean;
    readonly ownerIds: readonly string[];
  };
  readonly mongo: {
    readonly uri: string;
    /** When unset, the database named in the connection string is used. */
    readonly dbName: string | undefined;
    readonly maxPoolSize: number;
    readonly appName: string;
  };
  readonly bot: {
    readonly defaultPrefix: string;
    readonly prefixCacheTtlMs: number;
  };
  readonly log: {
    readonly level: LogLevel;
  };
}

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function required(env: Env, key: string): string {
  const value = read(env, key);
  if (!value) throw new ConfigError(`Missing required environment variable ${key}`);
  return value;
}

function integer(env: Env, key: string, fallback: number): number {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new ConfigError(`${key} must be a positive integer, got "${raw}"`);
  return value;
}

function boolean(env: Env, key: string, fallback: boolean): boolean {
  const raw = read(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false, got "${raw}"`);
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw as T;
}

function list(env: Env, key: string): string[] {
  return (read(env, key) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const config: AppConfig = {
    env: oneOf(env, 'NODE_ENV', ['development', 'production', 'test'], 'production'),
    discord: {
      token: required(env, 'DISCORD_TOKEN'),
      devGuildId: read(env, 'DEV_GUILD_ID'),
      syncCommands: boolean(env, 'SYNC_COMMANDS', true),
      ownerIds: list(env, 'OWNER_IDS'),
    },
    mongo: {
      uri: required(env, 'MONGO_CONNECTION_STRING'),
      dbName: read(env, 'MONGO_DB_NAME'),
      maxPoolSize: integer(env, 'MONGO_MAX_POOL_SIZE', 10),
      appName: read(env, 'MONGO_APP_NAME') ?? 'nexus-bot',
    },
    bot: {
      defaultPrefix: read(env, 'DEFAULT_PREFIX') ?? '!',
      prefixCacheTtlMs: integer(env, 'PREFIX_CACHE_TTL_SECONDS', 300) * 1000,
    },
    log: {
      level: oneOf(env, 'LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info'),
    },
  };
  return deepFreeze(config);
}
