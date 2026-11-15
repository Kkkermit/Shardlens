import type { FastifyInstance } from 'fastify';
import { openApiDocument } from '../openapi.js';
import { badgeValue } from '../query/reports.js';
import { runQuery } from '../query/run.js';
import { QuerySpec } from '../query/spec.js';
import { bearerToken } from '../security/auth.js';
import type { Deps } from '../server.js';
import { activeSalts } from '../storage/maintenance.js';
import type { SaltPeriod } from '../storage/periods.js';
import { requireReader } from './guard.js';

export async function apiRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/v1/config', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await deps.keys.verify(bearerToken(req), 'ingest');
    if (!auth) return reply.code(401).send({ error: 'unauthorized' });
    const appRow = await deps.db.query<{ mode: 'privacy' | 'audit'; salt_period: SaltPeriod }>(
      'SELECT mode, salt_period FROM apps WHERE app_id = $1',
      [auth.appId],
    );
    const a = appRow.rows[0];
    if (!a) return reply.code(404).send({ error: 'unknown_app' });
    const sampling = await deps.db.query<{ value: Record<string, number> }>(
      "SELECT value FROM settings WHERE app_id = $1 AND key = 'sampling'",
      [auth.appId],
    );
    const salts = await activeSalts(deps.db, auth.appId, a.salt_period);
    reply.header('cache-control', 'no-store');
    return {
      v: 1,
      appId: auth.appId,
      mode: a.mode,
      saltPeriod: a.salt_period,
      salts: salts.map((s) => ({ period: s.period, salt: s.secret.toString('base64url') })),
      sampling: sampling.rows[0]?.value ?? {},
      serverTime: new Date().toISOString(),
    };
  });

  app.post('/v1/query', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const appId = await requireReader(deps, req, reply);
    if (!appId) return;
    const spec = QuerySpec.parse(req.body);
    return runQuery(deps.db, appId, spec, new Date(), deps.analytics);
  });

  app.get('/v1/meta', async (req, reply) => {
    const appId = await requireReader(deps, req, reply);
    if (!appId) return;
    const res = await deps.db.query(
      `SELECT a.app_id::text AS "appId", coalesce(nullif(a.name, ''), i.name, 'Your bot') AS name, a.mode,
              a.salt_period AS "saltPeriod", a.timezone, a.raw_retention_days AS "rawRetentionDays"
         FROM apps a LEFT JOIN app_info i USING (app_id) WHERE a.app_id = $1`,
      [appId],
    );
    return {
      ...res.rows[0],
      auditKeyConfigured: deps.config.auditKey !== undefined,
      discordLogin: deps.config.discord !== undefined,
      webhookEventsConfigured: deps.config.discordPublicKey !== undefined,
    };
  });

  let connections = 0;
  app.get('/v1/live', async (req, reply) => {
    const appId = await requireReader(deps, req, reply);
    if (!appId) return;
    if (connections >= 100) return reply.code(503).header('retry-after', '10').send({ error: 'busy' });
    connections++;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    let slow: Record<string, unknown> = {};
    let slowAt = 0;
    const refreshSlow = async () => {
      const [p95, shards, servers] = await Promise.all([
        deps.db.query<{ p95: number | null }>(
          `SELECT shardlens_hist_quantile(shardlens_hist_sum(shardlens_hist_one(ack_ms, weight)), 0.95)::float8 AS p95
             FROM interactions WHERE app_id = $1 AND ts > now() - interval '5 minutes'`,
          [appId],
        ),
        deps.db.query<{ shard: number; ping: number; fresh: boolean }>(
          `SELECT DISTINCT ON (shard) shard, value::float8 AS ping, ts > now() - interval '2 minutes' AS fresh
             FROM gauges WHERE app_id = $1 AND name = 'shard.ping_ms' AND ts > now() - interval '1 hour'
            ORDER BY shard, ts DESC`,
          [appId],
        ),
        deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM guilds WHERE app_id = $1 AND left_at IS NULL', [
          appId,
        ]),
      ]);
      slow = {
        p95Ms5m: p95.rows[0]?.p95 ?? null,
        shards: shards.rows,
        activeShards: shards.rows.filter((s) => s.fresh).length,
        staleShards: shards.rows.filter((s) => !s.fresh).map((s) => s.shard),
        servers: servers.rows[0]?.n ?? 0,
      };
      slowAt = Date.now();
    };

    let closed = false;
    let sending = false;
    let failureLogged = false;
    const send = async () => {
      // A slow database must not pile up one refresh per second per connection.
      if (closed || sending) return;
      sending = true;
      try {
        if (Date.now() - slowAt > 10_000) await refreshSlow();
        const tiles = { ts: new Date().toISOString(), ...deps.live.tiles(appId), ...slow };
        if (!closed) res.write(`event: tiles\ndata: ${JSON.stringify(tiles)}\n\n`);
      } catch (error) {
        // Once per connection: this runs every second while the database is unreachable.
        if (!failureLogged) req.log.warn({ err: error }, 'live update failed');
        failureLogged = true;
        if (!closed) res.write('event: error\ndata: {}\n\n');
      } finally {
        sending = false;
      }
    };
    const timer = setInterval(() => void send(), 1_000);
    void send();
    req.raw.on('close', () => {
      closed = true;
      clearInterval(timer);
      connections--;
    });
  });

  const BADGE_LABELS: Record<string, string> = {
    servers: 'servers',
    'users-monthly': 'monthly users',
    'commands-daily': 'commands/day',
  };
  const badgeCache = new Map<string, { at: number; svg: string }>();
  app.get('/v1/badge/:metric', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = (req.params as { metric?: string }).metric ?? '';
    const metric = raw.replace(/\.svg$/, '');
    const label = BADGE_LABELS[metric];
    if (!label) return reply.code(404).send({ error: 'not_found' });
    const enabled = await deps.db.query<{ on: boolean }>(
      "SELECT value ? $2 AS on FROM settings WHERE app_id = $1 AND key = 'badges'",
      [deps.config.appId, metric],
    );
    if (!enabled.rows[0]?.on) return reply.code(404).send({ error: 'badge_disabled' });
    const cached = badgeCache.get(metric);
    let svg = cached && Date.now() - cached.at < 600_000 ? cached.svg : undefined;
    if (!svg) {
      const value = await badgeValue(deps.db, deps.config.appId, metric);
      svg = badgeSvg(
        label,
        value === null ? 'n/a' : new Intl.NumberFormat('en', { notation: 'compact' }).format(value),
      );
      badgeCache.set(metric, { at: Date.now(), svg });
    }
    return reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=600')
      .send(svg);
  });

  let openapi: string | undefined;
  app.get('/openapi.json', async (_req, reply) => {
    openapi ??= JSON.stringify(openApiDocument());
    return reply.header('content-type', 'application/json; charset=utf-8').send(openapi);
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.db.query('SELECT 1 FROM pgmigrations LIMIT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
}

/** A small shields-style badge. Both strings come from fixed labels and formatted numbers, never from input. */
function badgeSvg(label: string, value: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const lw = 10 + label.length * 6.5;
  const vw = 10 + value.length * 7.5;
  const w = Math.round(lw + vw + 18);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<rect width="${w}" height="20" rx="4" fill="#52514e"/>
<rect x="${Math.round(lw + 18)}" width="${Math.round(vw)}" height="20" rx="4" fill="#2a78d6"/>
<rect x="${Math.round(lw + 18)}" width="6" height="20" fill="#2a78d6"/>
<path d="M5 14l3-6 2.5 4 2-3 2 5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
<g fill="#fff" font-family="system-ui,Segoe UI,sans-serif" font-size="11">
<text x="20" y="14">${esc(label)}</text>
<text x="${Math.round(lw + 23)}" y="14">${esc(value)}</text>
</g>
</svg>`;
}
