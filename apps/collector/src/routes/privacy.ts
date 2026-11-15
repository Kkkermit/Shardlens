import { Snowflake } from '@shardlens/schema';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { KIND_NAME, OUTCOME_NAME, parseUserHash } from '../ingest/codes.js';
import { bearerToken } from '../security/auth.js';
import { auditCipher } from '../security/crypto.js';
import { csvRow } from '../security/csv.js';
import { hmacUser } from '../security/userhash.js';
import type { Deps } from '../server.js';
import { hasCsrfHeader } from './auth.js';
import { requireAdmin } from './guard.js';

export const EraseBody = z
  .object({
    userHashes: z
      .array(z.string().regex(/^h1:[0-9A-Za-z-]+:[0-9a-f]{32}$/))
      .max(8)
      .default([]),
    userId: Snowflake.optional(),
  })
  .strict();

/** Query parameters of the activity log and its export. Strict, so a misspelt filter is refused, not ignored. */
export const AuditLogFilters = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    /** Paging: `nextBefore` from the previous page (a time, then `~` and the last row's ID), or a time. */
    before: z
      .union([z.iso.datetime({ offset: true }), z.string().regex(/^[\dT:.+-]{20,35}Z?~[0-9a-f-]{36}$/i)])
      .optional(),
    command: z.string().max(32).optional(),
    guild: Snowflake.optional(),
    user: Snowflake.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** `null` for a value this key can't read (written under another audit key). */
function decryptOrNull(cipher: ReturnType<typeof auditCipher> | undefined, blob: Buffer | null): string | null {
  if (!blob || !cipher) return null;
  try {
    return cipher.decrypt(blob);
  } catch {
    return null;
  }
}

async function appMode(db: Db, appId: string): Promise<string | undefined> {
  const res = await db.query<{ mode: string }>('SELECT mode FROM apps WHERE app_id = $1', [appId]);
  return res.rows[0]?.mode;
}

async function logAccess(db: Db, appId: string, viewer: string | null, action: string, details: object) {
  await db.query('INSERT INTO audit_access_log (app_id, viewer_user_id, action, details) VALUES ($1, $2, $3, $4)', [
    appId,
    viewer ?? '0',
    action,
    JSON.stringify(details),
  ]);
}

/**
 * Deletes everything stored for a user: raw rows by hash (current and previous salt period), unique-user rows, and in
 * audit mode the encrypted activity log and install records. Aggregate counts already rolled up stay (they are
 * anonymous). Returns the number of rows removed.
 */
async function eraseUser(
  deps: Deps,
  appId: string,
  input: { hashes: Buffer[]; userId?: string | undefined },
): Promise<number> {
  const db = deps.db;
  const hashes = [...input.hashes];
  if (input.userId) {
    // Hash the ID with every live salt, so an exact-ID erase covers all periods still linkable.
    const salts = await db.query<{ secret: Buffer }>(
      'SELECT secret FROM salts WHERE app_id = $1 AND secret IS NOT NULL',
      [appId],
    );
    for (const s of salts.rows) hashes.push(hmacUser(s.secret, input.userId));
  }
  let erased = 0;
  if (hashes.length > 0) {
    for (const table of [
      'interactions',
      'custom_events',
      'uniques',
      'entitlements',
      'subscriptions',
      'webhook_events',
    ]) {
      const res = await db.query(`DELETE FROM ${table} WHERE app_id = $1 AND user_hash = ANY($2::bytea[])`, [
        appId,
        hashes,
      ]);
      erased += res.rowCount ?? 0;
    }
    // The ClickHouse and sink copies too. If one fails the request fails, so the caller retries (deletes are
    // idempotent). Copies aren't added to `erased`, which counts the collector's own rows.
    await deps.analytics?.erase(appId, hashes);
    await deps.sink?.erase(appId, hashes);
  }
  if (input.userId && deps.config.auditKey) {
    const cipher = auditCipher(deps.config.auditKey);
    const res = await db.query('DELETE FROM audit_log WHERE app_id = $1 AND actor_lookup = $2', [
      appId,
      cipher.lookupHash(input.userId),
    ]);
    erased += res.rowCount ?? 0;
    const installers = await db.query<{ id: string; ts: Date; actor_enc: Buffer }>(
      'SELECT id, ts, actor_enc FROM webhook_events WHERE app_id = $1 AND actor_enc IS NOT NULL',
      [appId],
    );
    for (const w of installers.rows) {
      if (decryptOrNull(cipher, w.actor_enc) === input.userId) {
        await db.query('UPDATE webhook_events SET actor_enc = NULL WHERE id = $1 AND ts = $2', [w.id, w.ts]);
        erased++;
      }
    }
  }
  return erased;
}

export async function privacyRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const cipher = deps.config.auditKey ? auditCipher(deps.config.auditKey) : undefined;
  const decrypt = (blob: Buffer | null) => decryptOrNull(cipher, blob);

  app.post('/v1/privacy/erase', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = EraseBody.parse(req.body ?? {});
    const key = await deps.keys.verify(bearerToken(req), 'ingest');
    let appId: string;
    let viewer: string | null = null;
    if (key) {
      appId = key.appId;
      // From the SDK, a raw ID is accepted only in audit mode (it is already stored, encrypted, there).
      if (body.userId && (await appMode(deps.db, appId)) !== 'audit') {
        return reply.code(400).send({ error: 'raw_id_only_in_audit_mode' });
      }
    } else {
      const admin = await requireAdmin(deps, req, reply, { mutate: true });
      if (!admin) return;
      appId = admin.appId;
      viewer = admin.userId;
    }
    const hashes = body.userHashes.map((h) => parseUserHash(h)?.bytes).filter((b): b is Buffer => b !== undefined);
    if (hashes.length === 0 && !body.userId) return reply.code(400).send({ error: 'nothing_to_erase' });
    const erased = await eraseUser(deps, appId, { hashes, userId: body.userId });
    await logAccess(deps.db, appId, viewer, 'erase', {
      via: key ? 'sdk' : 'dashboard',
      erased,
      byId: Boolean(body.userId),
    });
    return { erased };
  });

  const requireAudit = async (req: FastifyRequest, reply: FastifyReply) => {
    const admin = await requireAdmin(deps, req, reply);
    if (!admin) return undefined;
    if (!cipher || (await appMode(deps.db, admin.appId)) !== 'audit') {
      await reply.code(404).send({ error: 'audit_mode_off' });
      return undefined;
    }
    return admin;
  };

  const fetchLog = async (appId: string, f: z.output<typeof AuditLogFilters>, maxRows: number) => {
    const params: unknown[] = [appId];
    const where = ['a.app_id = $1'];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.from) add('a.ts >= ?', f.from);
    if (f.to) add('a.ts < ?', f.to);
    if (f.before) {
      // The row ID breaks ties, so rows sharing the last time on a page aren't skipped.
      const [at, id] = f.before.split('~');
      if (id) {
        params.push(at, id);
        where.push(`(a.ts, a.interaction_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      } else add('a.ts < ?', at);
    }
    if (f.command) add('a.command = ?', f.command);
    if (f.guild) add('a.guild_id = ?', f.guild);
    if (f.user && cipher) add('a.actor_lookup = ?', cipher.lookupHash(f.user));
    params.push(maxRows);
    const res = await deps.db.query<{
      interaction_id: string;
      ts: Date;
      guild_id: string | null;
      guild_name: string | null;
      kind: number;
      command: string | null;
      sub: string | null;
      custom_id: string | null;
      outcome: number;
      ack_ms: number | null;
      actor_enc: Buffer;
      names_enc: Buffer | null;
    }>(
      `SELECT a.interaction_id, a.ts, a.guild_id::text, g.name AS guild_name, a.kind, a.command, a.sub, a.custom_id,
              a.outcome, a.ack_ms, a.actor_enc, a.names_enc
         FROM audit_log a LEFT JOIN guilds g ON g.app_id = a.app_id AND g.guild_id = a.guild_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.ts DESC, a.interaction_id DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => {
      const names = decrypt(r.names_enc);
      const profile = (names ? JSON.parse(names) : {}) as { username?: string; avatar?: string };
      return {
        interactionId: r.interaction_id,
        ts: r.ts,
        guildId: r.guild_id,
        guildName: r.guild_name,
        kind: KIND_NAME[r.kind] ?? String(r.kind),
        command: r.command,
        sub: r.sub,
        customId: r.custom_id,
        outcome: OUTCOME_NAME[r.outcome] ?? String(r.outcome),
        ackMs: r.ack_ms,
        userId: decrypt(r.actor_enc),
        username: profile.username ?? null,
        avatar: profile.avatar ?? null,
      };
    });
  };

  app.get('/v1/audit/log', async (req, reply) => {
    const admin = await requireAudit(req, reply);
    if (!admin) return;
    const f = AuditLogFilters.parse(req.query);
    const rows = await fetchLog(admin.appId, f, f.limit);
    await logAccess(deps.db, admin.appId, admin.userId, f.user ? 'lookup_user' : 'view_log', {
      command: f.command ?? null,
      guild: f.guild ?? null,
      // The looked-up ID is recorded as its audit lookup key, not in clear.
      user: f.user && cipher ? cipher.lookupHash(f.user).toString('hex') : null,
      rows: rows.length,
    });
    const last = rows.length === f.limit ? rows.at(-1) : undefined;
    return { rows, nextBefore: last ? `${last.ts.toISOString()}~${last.interactionId}` : null };
  });

  app.get('/v1/audit/top-users', async (req, reply) => {
    const admin = await requireAudit(req, reply);
    if (!admin) return;
    const { window } = z.object({ window: z.enum(['24h', '7d']).default('24h') }).parse(req.query);
    const res = await deps.db.query<{ actor_enc: Buffer; runs: number }>(
      `SELECT (array_agg(actor_enc ORDER BY ts DESC))[1] AS actor_enc, count(*)::int AS runs
         FROM audit_log WHERE app_id = $1 AND ts >= now() - $2::interval
        GROUP BY actor_lookup ORDER BY runs DESC LIMIT 25`,
      [admin.appId, window === '24h' ? '24 hours' : '7 days'],
    );
    await logAccess(deps.db, admin.appId, admin.userId, 'top_users', { window });
    return {
      window,
      rows: res.rows.map((r) => ({ userId: decrypt(r.actor_enc), runs: r.runs })),
    };
  });

  app.get(
    '/v1/audit/export.csv',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const admin = await requireAudit(req, reply);
      if (!admin) return;
      // Exports need explicit re-confirmation: a header a link or image tag can't send.
      if (req.headers['x-shardlens-confirm'] !== 'export-audit-log' || !hasCsrfHeader(req)) {
        return reply.code(428).send({ error: 'confirmation_required' });
      }
      const f = AuditLogFilters.parse(req.query);
      const rows = await fetchLog(admin.appId, f, 10_000);
      await logAccess(deps.db, admin.appId, admin.userId, 'export', {
        rows: rows.length,
        from: f.from ?? null,
        to: f.to ?? null,
      });
      const header = [
        'time',
        'user_id',
        'username',
        'server_id',
        'server',
        'kind',
        'command',
        'sub',
        'custom_id',
        'outcome',
        'ack_ms',
      ];
      const body = [
        csvRow(header),
        ...rows.map((r) =>
          csvRow([
            r.ts.toISOString(),
            r.userId,
            r.username,
            r.guildId,
            r.guildName,
            r.kind,
            r.command,
            r.sub,
            r.customId,
            r.outcome,
            r.ackMs,
          ]),
        ),
      ].join('');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="shardlens-activity.csv"')
        .header('cache-control', 'no-store')
        .send(body);
    },
  );

  app.get('/v1/audit/access-log', async (req, reply) => {
    const admin = await requireAdmin(deps, req, reply);
    if (!admin) return;
    const res = await deps.db.query(
      `SELECT ts, viewer_user_id::text AS "viewerUserId", action, details FROM audit_access_log
        WHERE app_id = $1 ORDER BY ts DESC LIMIT 200`,
      [admin.appId],
    );
    return { rows: res.rows };
  });
}
