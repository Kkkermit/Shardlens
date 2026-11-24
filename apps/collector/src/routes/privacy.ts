import { Snowflake } from '@shardlens/schema';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KIND_NAME, OUTCOME_NAME, parseUserHash } from '../ingest/codes.js';
import { bearerToken } from '../security/auth.js';
import { auditCipher } from '../security/crypto.js';
import { csvRow } from '../security/csv.js';
import { hmacUser } from '../security/userhash.js';
import type { Deps } from '../server.js';
import type { Store } from '../storage/store.js';
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
    /** One outcome, or `failed` for every outcome but `ok`. */
    outcome: z.enum(['ok', 'error', 'timeout', 'no_response', 'failed']).optional(),
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

async function appMode(store: Store, appId: string): Promise<string | undefined> {
  return (await store.apps.get(appId))?.mode;
}

/** Who is reading audit data: a person signed in with Discord, or a backend holding an activity key. */
interface Viewer {
  userId: string | null;
  keyId?: string | null;
}

async function logAccess(store: Store, appId: string, viewer: Viewer, action: string, details: object) {
  await store.privacy.logAccess({
    appId,
    viewerUserId: viewer.userId ?? '0',
    viewerKeyId: viewer.keyId ?? null,
    action,
    details,
  });
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
  const { store } = deps;
  const hashes = [...input.hashes];
  if (input.userId) {
    // Hash the ID with every live salt, so an exact-ID erase covers all periods still linkable.
    for (const secret of await store.salts.liveSecrets(appId)) hashes.push(hmacUser(secret, input.userId));
  }
  let erased = 0;
  if (hashes.length > 0) {
    erased += await store.privacy.eraseHashes(appId, hashes);
    // The ClickHouse and sink copies too. If one fails the request fails, so the caller retries (deletes are
    // idempotent). Copies aren't added to `erased`, which counts the collector's own rows.
    await deps.analytics?.erase(appId, hashes);
    await deps.sink?.erase(appId, hashes);
  }
  if (input.userId && deps.config.auditKey) {
    const cipher = auditCipher(deps.config.auditKey);
    erased += await store.privacy.eraseActivity(appId, cipher.lookupHash(input.userId));
    for (const w of await store.privacy.installers(appId)) {
      if (decryptOrNull(cipher, w.actor) === input.userId) {
        await store.privacy.forgetInstaller(w.id, w.ts);
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
      if (body.userId && (await appMode(deps.store, appId)) !== 'audit') {
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
    await logAccess(deps.store, appId, { userId: viewer }, 'erase', {
      via: key ? 'sdk' : 'dashboard',
      erased,
      byId: Boolean(body.userId),
    });
    return { erased };
  });

  const auditOn = async (appId: string, reply: FastifyReply): Promise<boolean> => {
    if (cipher && (await appMode(deps.store, appId)) === 'audit') return true;
    await reply.code(404).send({ error: 'audit_mode_off' });
    return false;
  };

  const requireAudit = async (req: FastifyRequest, reply: FastifyReply) => {
    const admin = await requireAdmin(deps, req, reply);
    return admin && (await auditOn(admin.appId, reply)) ? admin : undefined;
  };

  /**
   * A dashboard of the owner's own asks again on every refresh, so a key repeating the same `request` (down to its
   * page) within a minute is logged once. Any other page is another read: paging through the log is logged page by
   * page, as a person's reads always are.
   */
  const keyReads = new Map<string, number>();
  const logRead = async (viewer: Viewer & { appId: string }, action: string, details: object, request: object) => {
    if (viewer.keyId) {
      const read = `${viewer.keyId} ${action} ${JSON.stringify(request)}`;
      const now = Date.now();
      if (now - (keyReads.get(read) ?? 0) < 60_000) return;
      if (keyReads.size >= 5_000) keyReads.clear();
      keyReads.set(read, now);
    }
    await logAccess(deps.store, viewer.appId, viewer, action, details);
  };

  /**
   * The activity log is also read by the owner's own dashboard, with an activity key in place of a Discord sign-in.
   * A request that presents any key is judged by that key alone, never by a session cookie sent along with it.
   */
  const requireActivityReader = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<(Viewer & { appId: string }) | undefined> => {
    const token = bearerToken(req);
    if (token === undefined) {
      const admin = await requireAudit(req, reply);
      return admin && { appId: admin.appId, userId: admin.userId };
    }
    const key = await deps.keys.verify(token, 'activity');
    if (!key) {
      const reads = await deps.keys.verify(token, 'read');
      await reply.code(reads ? 403 : 401).send({ error: reads ? 'activity_key_required' : 'unauthorized' });
      return undefined;
    }
    return (await auditOn(key.appId, reply)) ? { appId: key.appId, userId: null, keyId: key.keyId } : undefined;
  };

  const fetchLog = async (appId: string, f: z.output<typeof AuditLogFilters>, maxRows: number) => {
    // The row ID breaks ties, so rows sharing the last time on a page aren't skipped.
    const [before, beforeId] = (f.before?.split('~') ?? []) as [string?, string?];
    const rows = await deps.store.privacy.activity(
      appId,
      {
        from: f.from,
        to: f.to,
        before: before === undefined ? undefined : { ts: before, id: beforeId },
        command: f.command,
        guild: f.guild,
        actorLookup: f.user && cipher ? cipher.lookupHash(f.user) : undefined,
        outcome: f.outcome,
      },
      maxRows,
    );
    return rows.map((r) => {
      const names = decrypt(r.profile);
      const profile = (names ? JSON.parse(names) : {}) as { username?: string; avatar?: string };
      return {
        interactionId: r.interactionId,
        ts: r.ts,
        guildId: r.guildId,
        guildName: r.guildName,
        kind: KIND_NAME[r.kind] ?? String(r.kind),
        command: r.command,
        sub: r.sub,
        customId: r.customId,
        outcome: OUTCOME_NAME[r.outcome] ?? String(r.outcome),
        ackMs: r.ackMs,
        userId: decrypt(r.userId),
        username: profile.username ?? null,
        avatar: profile.avatar ?? null,
      };
    });
  };

  app.get('/v1/audit/log', async (req, reply) => {
    const viewer = await requireActivityReader(req, reply);
    if (!viewer) return;
    const f = AuditLogFilters.parse(req.query);
    const rows = await fetchLog(viewer.appId, f, f.limit);
    const filters = {
      command: f.command ?? null,
      guild: f.guild ?? null,
      outcome: f.outcome ?? null,
      // The looked-up ID is recorded as its audit lookup key, not in clear.
      user: f.user && cipher ? cipher.lookupHash(f.user).toString('hex') : null,
    };
    const page = { from: f.from ?? null, to: f.to ?? null, before: f.before ?? null, limit: f.limit };
    await logRead(
      viewer,
      f.user ? 'lookup_user' : 'view_log',
      { ...filters, rows: rows.length },
      { ...filters, ...page },
    );
    const last = rows.length === f.limit ? rows.at(-1) : undefined;
    return { rows, nextBefore: last ? `${last.ts.toISOString()}~${last.interactionId}` : null };
  });

  app.get('/v1/audit/top-users', async (req, reply) => {
    const viewer = await requireActivityReader(req, reply);
    if (!viewer) return;
    const { window } = z.object({ window: z.enum(['24h', '7d']).default('24h') }).parse(req.query);
    const top = await deps.store.privacy.topActors(viewer.appId, window);
    await logRead(viewer, 'top_users', { window }, { window });
    return {
      window,
      rows: top.map((r) => ({ userId: decrypt(r.userId), runs: r.runs })),
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
      await logAccess(deps.store, admin.appId, { userId: admin.userId }, 'export', {
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
    return { rows: await deps.store.privacy.accessLog(admin.appId) };
  });
}
