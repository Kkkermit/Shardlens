import type { Db } from '../../db.js';
import { OUTCOME } from '../../ingest/codes.js';
import type { AccessLogRow, PrivacyStorage } from '../store.js';

/** Every table that holds a salted user hash. */
const HASHED_TABLES = ['interactions', 'custom_events', 'uniques', 'entitlements', 'subscriptions', 'webhook_events'];

export function postgresPrivacy(db: Db): PrivacyStorage {
  return {
    async logAccess(entry) {
      await db.query(
        'INSERT INTO audit_access_log (app_id, viewer_user_id, viewer_key_id, action, details) VALUES ($1, $2, $3, $4, $5)',
        [entry.appId, entry.viewerUserId, entry.viewerKeyId, entry.action, JSON.stringify(entry.details)],
      );
    },

    async accessLog(appId) {
      const res = await db.query<AccessLogRow>(
        `SELECT l.ts, l.viewer_user_id::text AS "viewerUserId", k.label AS "viewerKey", l.action, l.details
           FROM audit_access_log l LEFT JOIN api_keys k ON k.id = l.viewer_key_id
          WHERE l.app_id = $1 ORDER BY l.ts DESC LIMIT 200`,
        [appId],
      );
      return res.rows;
    },

    async eraseHashes(appId, hashes) {
      let erased = 0;
      for (const table of HASHED_TABLES) {
        const res = await db.query(`DELETE FROM ${table} WHERE app_id = $1 AND user_hash = ANY($2::bytea[])`, [
          appId,
          hashes,
        ]);
        erased += res.rowCount ?? 0;
      }
      return erased;
    },

    async eraseActivity(appId, actorLookup) {
      const res = await db.query('DELETE FROM audit_log WHERE app_id = $1 AND actor_lookup = $2', [appId, actorLookup]);
      return res.rowCount ?? 0;
    },

    async installers(appId) {
      const installers = await db.query<{ id: string; ts: Date; actor_enc: Buffer }>(
        'SELECT id, ts, actor_enc FROM webhook_events WHERE app_id = $1 AND actor_enc IS NOT NULL',
        [appId],
      );
      return installers.rows.map((w) => ({ id: w.id, ts: w.ts, actor: w.actor_enc }));
    },

    async forgetInstaller(id, ts) {
      await db.query('UPDATE webhook_events SET actor_enc = NULL WHERE id = $1 AND ts = $2', [id, ts]);
    },

    async activity(appId, f, limit) {
      const params: unknown[] = [appId];
      const where = ['a.app_id = $1'];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (f.from) add('a.ts >= ?', f.from);
      if (f.to) add('a.ts < ?', f.to);
      if (f.before) {
        if (f.before.id) {
          params.push(f.before.ts, f.before.id);
          where.push(`(a.ts, a.interaction_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
        } else add('a.ts < ?', f.before.ts);
      }
      if (f.command) add('a.command = ?', f.command);
      if (f.guild) add('a.guild_id = ?', f.guild);
      if (f.actorLookup) add('a.actor_lookup = ?', f.actorLookup);
      // Written as a literal for every failed outcome: it is the condition of the indexes that hold only failures.
      if (f.outcome && f.outcome !== 'ok') where.push('a.outcome <> 0');
      if (f.outcome && f.outcome !== 'failed') add('a.outcome = ?', OUTCOME[f.outcome]);
      params.push(limit);
      const res = await db.query<{
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
      return res.rows.map((r) => ({
        interactionId: r.interaction_id,
        ts: r.ts,
        guildId: r.guild_id,
        guildName: r.guild_name,
        kind: r.kind,
        command: r.command,
        sub: r.sub,
        customId: r.custom_id,
        outcome: r.outcome,
        ackMs: r.ack_ms,
        userId: r.actor_enc,
        profile: r.names_enc,
      }));
    },

    async topActors(appId, window) {
      const res = await db.query<{ actor_enc: Buffer; runs: number }>(
        `SELECT (array_agg(actor_enc ORDER BY ts DESC))[1] AS actor_enc, count(*)::int AS runs
           FROM audit_log WHERE app_id = $1 AND ts >= now() - $2::interval
          GROUP BY actor_lookup ORDER BY runs DESC LIMIT 25`,
        [appId, window === '24h' ? '24 hours' : '7 days'],
      );
      return res.rows.map((r) => ({ userId: r.actor_enc, runs: r.runs }));
    },
  };
}
