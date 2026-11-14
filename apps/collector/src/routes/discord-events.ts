import { createHash } from 'node:crypto';
import { Snowflake } from '@shardlens/schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { insertRows } from '../db.js';
import { auditCipher } from '../security/crypto.js';
import { makeDiscordVerifier } from '../security/ed25519.js';
import { hashUserId } from '../security/userhash.js';
import type { Deps } from '../server.js';

const User = z.object({ id: Snowflake }).loose();

const Entitlement = z
  .object({
    id: Snowflake,
    sku_id: Snowflake,
    user_id: Snowflake.nullish(),
    guild_id: Snowflake.nullish(),
    type: z.number().int(),
    starts_at: z.string().nullish(),
    ends_at: z.string().nullish(),
    deleted: z.boolean().optional(),
  })
  .loose();

/** Discord webhook event payload (https://docs.discord.com/developers/events/webhook-events). Unknown keys ignored. */
const Payload = z
  .object({
    version: z.number().int(),
    application_id: Snowflake,
    type: z.union([z.literal(0), z.literal(1)]),
    event: z
      .object({
        type: z.string().max(64),
        timestamp: z.string().max(64),
        data: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .loose();

const MAX_QUEUE = 10_000;

interface Delivery {
  body: z.output<typeof Payload>;
  raw: Buffer;
}

/** Deterministic UUIDv7-shaped ID: Discord retries the same body, so a retried delivery is stored once. */
function deliveryId(ts: number, rawBody: Buffer): string {
  const h = createHash('sha256').update(rawBody).digest('hex');
  const t = Math.max(0, Math.floor(ts)).toString(16).padStart(12, '0').slice(-12);
  const variant = ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${h.slice(0, 3)}-${variant}${h.slice(3, 6)}-${h.slice(6, 18)}`;
}

/**
 * `POST /v1/discord/events`: Discord webhook events. The signature is checked over the raw body;
 * PING and events are answered `204` before any processing so Discord's 3-second limit is never at risk; events are
 * processed from a bounded in-memory queue. User IDs are hashed with the current salt, never stored raw (the
 * installer is kept encrypted in audit mode only).
 */
export async function discordEventRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const verify = deps.config.discordPublicKey ? makeDiscordVerifier(deps.config.discordPublicKey) : undefined;
  const audit = deps.config.auditKey ? auditCipher(deps.config.auditKey) : undefined;
  const queue: Delivery[] = [];
  let draining = false;

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  /** Stores one delivery. The `webhook.<type>` counters are rolled up from this table. */
  const recordDelivery = (
    item: Delivery,
    at: Date,
    fields: {
      integrationType?: number | null;
      userHash?: Buffer | undefined;
      actor?: Buffer | null;
      guildId?: string | null | undefined;
      scopes?: string[] | null;
    },
  ) =>
    insertRows(
      deps.db,
      'webhook_events',
      ['id', 'ts', 'app_id', 'type', 'integration_type', 'user_hash', 'actor_enc', 'guild_id', 'scopes'],
      [
        [
          deliveryId(at.getTime(), item.raw),
          at,
          deps.config.appId,
          item.body.event?.type,
          fields.integrationType ?? null,
          fields.userHash ?? null,
          fields.actor ?? null,
          fields.guildId ?? null,
          fields.scopes ?? null,
        ],
      ],
    );

  const processDelivery = async (item: Delivery) => {
    const event = item.body.event;
    if (!event) return;
    const appId = deps.config.appId;
    const ts = Date.parse(event.timestamp);
    const at = Number.isNaN(ts) ? new Date() : new Date(ts);
    const data = event.data ?? {};

    if (event.type === 'APPLICATION_AUTHORIZED' || event.type === 'APPLICATION_DEAUTHORIZED') {
      const user = User.safeParse(data.user);
      const guild = Snowflake.safeParse((data.guild as { id?: unknown } | undefined)?.id);
      const hash = user.success ? await hashUserId(deps.db, appId, user.data.id, at) : undefined;
      const mode = await deps.db.query<{ mode: string }>('SELECT mode FROM apps WHERE app_id = $1', [appId]);
      await recordDelivery(item, at, {
        integrationType: typeof data.integration_type === 'number' ? data.integration_type : null,
        userHash: hash?.bytes,
        actor: audit && mode.rows[0]?.mode === 'audit' && user.success ? audit.encrypt(user.data.id) : null,
        guildId: guild.success ? guild.data : null,
        scopes: Array.isArray(data.scopes) ? data.scopes.filter((s) => typeof s === 'string').slice(0, 20) : null,
      });
      return;
    }

    if (event.type.startsWith('ENTITLEMENT_')) {
      const e = Entitlement.safeParse(data);
      if (!e.success) return;
      const action =
        event.type === 'ENTITLEMENT_CREATE' ? 'create' : event.type === 'ENTITLEMENT_DELETE' ? 'delete' : 'update';
      const hash = e.data.user_id ? await hashUserId(deps.db, appId, e.data.user_id, at) : undefined;
      await insertRows(
        deps.db,
        'entitlements',
        [
          'app_id',
          'ts',
          'action',
          'sku_id',
          'entitlement_type',
          'owner',
          'user_hash',
          'guild_id',
          'starts_at',
          'ends_at',
          'source',
        ],
        [
          [
            appId,
            at,
            action,
            e.data.sku_id,
            e.data.type,
            e.data.guild_id ? 'guild' : 'user',
            hash?.bytes ?? null,
            e.data.guild_id ?? null,
            e.data.starts_at ? new Date(e.data.starts_at) : null,
            e.data.ends_at ? new Date(e.data.ends_at) : null,
            'webhook',
          ],
        ],
      );
      await recordDelivery(item, at, { userHash: hash?.bytes, guildId: e.data.guild_id });
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift()!;
        try {
          await processDelivery(item);
        } catch (error) {
          app.log.error({ err: error, type: item.body.event?.type }, 'webhook event processing failed');
        }
      }
    } finally {
      draining = false;
    }
  };

  app.post(
    '/v1/discord/events',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!verify) return reply.code(404).send({ error: 'webhook_events_not_configured' });
      const raw = req.body as Buffer;
      const signature = req.headers['x-signature-ed25519'];
      const timestamp = req.headers['x-signature-timestamp'];
      if (
        !verify(
          raw,
          typeof signature === 'string' ? signature : undefined,
          typeof timestamp === 'string' ? timestamp : undefined,
        )
      ) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      let parsed: z.output<typeof Payload>;
      try {
        parsed = Payload.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        return reply.code(400).send({ error: 'invalid_payload' });
      }
      if (parsed.application_id !== deps.config.appId) return reply.code(400).send({ error: 'app_mismatch' });
      // Acknowledge first (PING included); process afterwards.
      reply.code(204).send();
      if (parsed.type === 1 && queue.length < MAX_QUEUE) {
        queue.push({ body: parsed, raw });
        setImmediate(() => void drain());
      }
      return reply;
    },
  );
}
