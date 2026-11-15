import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { containsNul } from '@shardlens/schema';
import Fastify, { type FastifyInstance, type FastifyRequest, LogController } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import type { Config } from './env.js';
import type { LiveHub } from './live.js';
import { QueryError } from './query/run.js';
import { adminRoutes } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { authRoutes } from './routes/auth.js';
import { discordEventRoutes } from './routes/discord-events.js';
import { ingestRoutes } from './routes/ingest.js';
import { privacyRoutes } from './routes/privacy.js';
import { reportRoutes } from './routes/reports.js';
import type { KeyStore } from './security/auth.js';
import type { ClickHouseStore } from './storage/clickhouse.js';
import type { SinkMirror } from './storage/sink.js';

export interface Deps {
  config: Config;
  db: Db;
  keys: KeyStore;
  live: LiveHub;
  /** Optional ClickHouse analytics store (preview). */
  analytics?: ClickHouseStore | undefined;
  /** Optional copy of accepted events in the owner's own database. */
  sink?: SinkMirror | undefined;
  /** Where log lines go. Default: standard output. */
  logStream?: { write(line: string): void } | undefined;
}

/** Paths never written to logs. Request and response bodies are never logged at all. */
const LOG_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.token',
  '*.apiKey',
  '*.key',
  '*.user_hash',
  '*.actor',
  '*.secret',
];

/** Content-Security-Policy for the dashboard: same-origin everything, Discord CDN images only. */
const CSP = {
  defaultSrc: ["'self'"],
  imgSrc: ["'self'", 'https://cdn.discordapp.com'],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  connectSrc: ["'self'"],
  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/** Requests per minute from one address, for every route that doesn't set a limit of its own. */
const DEFAULT_RATE_LIMIT = 1_200;
/** How long a client may take to send a whole request. Without a limit, a slow trickle holds a connection open forever. */
const REQUEST_TIMEOUT_MS = 30_000;
const API_PATHS = /^\/(v1|auth)\/|^\/(healthz|readyz|openapi\.json)$/;
/** A path that names a file. A missing one is a 404: a script URL answered with the dashboard's HTML fails oddly. */
const FILE_PATH = /^\/assets\/|\.[a-z0-9]{1,8}$/i;

/** A PostgreSQL "data exception" (SQLSTATE class 22): the statement was fine, a value in it was not. */
function isDataException(error: unknown): error is { code: string } {
  const e = error as { code?: unknown; severity?: unknown } | null;
  return typeof e?.code === 'string' && /^22[0-9A-Z]{3}$/.test(e.code) && typeof e.severity === 'string';
}

/** The reply failed only because the client closed the connection (a page navigating away mid-request). */
function isClientGone(error: unknown, req: FastifyRequest): boolean {
  return (
    (error as { code?: unknown } | null)?.code === 'ERR_STREAM_PREMATURE_CLOSE' || req.raw.socket?.destroyed === true
  );
}

/**
 * The rate-limit bucket for a request: its client address. A client that has already hung up has none, and the
 * limiter's own key function throws on that, so those requests share one bucket instead.
 */
export function clientKey(req: Pick<FastifyRequest, 'ip'>): string {
  return req.ip ?? 'disconnected';
}

function dashboardDir(config: Config): string | undefined {
  const candidates = [
    config.dashboardDir,
    fileURLToPath(new URL('../public', import.meta.url)),
    fileURLToPath(new URL('../../dashboard/dist', import.meta.url)),
  ];
  return candidates.find((dir) => dir !== undefined && existsSync(`${dir}/index.html`));
}

/** A hop count trusts that many proxies from the right of `X-Forwarded-For`, the same rule Fastify applies to a number. */
function proxyTrust(trust: boolean | number): boolean | ((address: string, hop: number) => boolean) {
  return typeof trust === 'number' ? (_address, hop) => hop < trust : trust;
}

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  // Request logs record URLs (the OAuth callback's one-time code, a key pasted into a query string), so they are
  // written only when the collector runs at debug or trace.
  const verbose = deps.config.logLevel === 'debug' || deps.config.logLevel === 'trace';
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      redact: { paths: LOG_REDACT, censor: '[redacted]' },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    logController: new LogController({ disableRequestLogging: !verbose }),
    trustProxy: proxyTrust(deps.config.trustProxy),
    bodyLimit: 256 * 1024,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });

  await app.register(cookie, { secret: deps.config.sessionSecret });
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CSP },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: DEFAULT_RATE_LIMIT,
    timeWindow: '1 minute',
    keyGenerator: clientKey,
  });
  // @fastify/compress would also inflate gzipped *requests* on every route, bypassing ingest's bounded gunzip (the
  // gzip-bomb guard). Request decompression is switched off everywhere; responses are still compressed.
  app.addHook('onRoute', (route) => {
    route.decompress ??= false;
  });
  await app.register(compress, { global: true, encodings: ['gzip', 'br'] });
  // API answers hold analytics, keys and, in audit mode, decrypted user IDs: no browser or proxy cache may keep one,
  // unless its route says otherwise (public badges).
  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('cache-control') && /^\/(v1|auth)\//.test(req.url)) reply.header('cache-control', 'no-store');
    return payload;
  });

  // PostgreSQL text can't hold NUL. Ingest reads its body as a buffer and checks each event itself.
  app.addHook('preValidation', async (req, reply) => {
    const body = Buffer.isBuffer(req.body) ? undefined : req.body;
    if (containsNul(body) || containsNul(req.query) || containsNul(req.params)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_request', issues: error.issues.slice(0, 20) });
    }
    if (error instanceof QueryError) return reply.code(400).send({ error: 'invalid_query', message: error.message });
    if (isDataException(error)) {
      // Input the database refused (a number out of range, text it can't store). Not a fault of the collector, and
      // answering 500 would make an SDK retry the same batch forever.
      req.log.warn({ code: error.code, route: req.routeOptions.url }, 'input refused by the database');
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: 'rate_limited' });
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (error as { code?: string }).code ?? 'bad_request' });
    }
    if (isClientGone(error, req)) {
      req.log.debug({ route: req.routeOptions.url }, 'client disconnected before the reply was sent');
      return reply.code(499).send();
    }
    req.log.error({ err: error, method: req.method, route: req.routeOptions.url }, 'request failed');
    // The ID is in the log line above, so a report from the dashboard can be matched to it.
    return reply.code(500).send({ error: 'internal', requestId: req.id });
  });

  // Ingest and the webhook receiver replace the JSON parser (they need the raw body), so every group of routes gets
  // its own encapsulated scope.
  await app.register(async (scope) => ingestRoutes(scope, deps));
  await app.register(async (scope) => apiRoutes(scope, deps));
  await app.register(async (scope) => authRoutes(scope, deps));
  await app.register(async (scope) => discordEventRoutes(scope, deps));
  await app.register(async (scope) => privacyRoutes(scope, deps));
  await app.register(async (scope) => adminRoutes(scope, deps));
  await app.register(async (scope) => reportRoutes(scope, deps));

  const dir = dashboardDir(deps.config);
  if (dir) {
    await app.register(fastifyStatic, {
      root: dir,
      wildcard: false,
      index: ['index.html'],
      // The page must be revalidated, or after an upgrade a cached copy asks for scripts that no longer exist. Built
      // assets have content-hashed names, so they never change.
      cacheControl: false,
      setHeaders: (res, file) => {
        const policy = file.endsWith('index.html')
          ? 'no-cache'
          : /[\\/]assets[\\/]/.test(file)
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=3600';
        res.header('cache-control', policy);
      },
    });
  } else {
    app.get('/', async () => ({ name: 'shardlens-collector', dashboard: 'not built' }));
  }
  // Single-page app: unknown GETs for a page (not the API, not a file) return the dashboard shell.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!dir || req.method !== 'GET' || API_PATHS.test(path) || FILE_PATH.test(path)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });

  return app;
}
