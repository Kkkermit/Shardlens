import { type Event, parseBatch } from '@shardlens/schema';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bearerToken, type KeyAuth } from '../security/auth.js';
import { auditCipher } from '../security/crypto.js';
import { gunzipBounded } from '../security/gzip.js';
import type { Deps } from '../server.js';
import { ACCEPT_BACK_DAYS, RETENTION_DAYS } from '../storage/retention.js';
import type { IngestContext, IngestItem, WriteResult } from '../storage/store.js';

const MAX_SKEW_MS = 5 * 60_000;
const MAX_FUTURE_MS = 86_400_000;
const MAX_IN_FLIGHT = 16;

/** For a batch when it and the app are both in audit mode and the audit key is configured. */
interface Audit {
  cipher: ReturnType<typeof auditCipher>;
  oldestMs: number;
}

/**
 * The item as the store gets it: who ran a command never reaches the store in clear. The identity is encrypted with
 * the audit key in audit mode within audit retention, and left out otherwise.
 */
function sealActor(item: IngestItem, audit: Audit | undefined): IngestItem {
  const e = item.event;
  if ((e.type !== 'interaction' && e.type !== 'message_command') || !e.actor) return item;
  const { actor, ...event } = e;
  if (!audit || e.ts < audit.oldestMs) return { index: item.index, event: event as Event };
  const { cipher } = audit;
  const named = actor.username !== undefined || actor.avatar !== undefined;
  return {
    index: item.index,
    event: event as Event,
    actor: {
      lookup: cipher.lookupHash(actor.userId),
      userId: cipher.encrypt(actor.userId),
      profile: named ? cipher.encrypt(JSON.stringify({ username: actor.username, avatar: actor.avatar })) : null,
    },
  };
}

/** `POST /v1/ingest`: SDK batches. */
export async function ingestRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  let inFlight = 0;
  // The clock correction last applied to each sending process. Duplicates are found by event ID and time, so a retried
  // batch must get exactly the same correction, not one a few milliseconds of network delay apart.
  const corrections = new Map<string, number>();
  const correction = (sender: string, skew: number) => {
    const last = corrections.get(sender);
    if (last !== undefined && Math.abs(last - skew) < 60_000) return last;
    if (corrections.size >= 10_000) corrections.clear();
    const shift = Math.round(skew / 60_000) * 60_000;
    corrections.set(sender, shift);
    return shift;
  };

  // This route reads the raw (usually gzipped) body itself, so the default JSON parser is replaced here only.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  const authenticated = new WeakMap<FastifyRequest, KeyAuth>();

  app.post(
    '/v1/ingest',
    {
      config: { rateLimit: { max: 3_000, timeWindow: '1 minute' } },
      // Checked before the body is read, so a caller without a key can't make the collector buffer anything.
      preParsing: async (req, reply) => {
        const auth = await deps.keys.verify(bearerToken(req), 'ingest');
        if (auth) authenticated.set(req, auth);
        else await reply.code(401).send({ error: 'unauthorized' });
      },
    },
    async (req, reply) => {
      const auth = authenticated.get(req);
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      if (inFlight >= MAX_IN_FLIGHT) {
        return reply.code(503).header('retry-after', '5').send({ error: 'busy' });
      }
      inFlight++;
      try {
        let raw = req.body as Buffer;
        const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
        if (encoding === 'gzip') {
          try {
            raw = await gunzipBounded(raw);
          } catch (error) {
            // A RangeError is the size guard; anything else is a body that isn't gzip at all.
            if (error instanceof RangeError) return reply.code(413).send({ error: 'body_too_large' });
            return reply.code(400).send({ error: 'invalid_encoding' });
          }
        } else if (encoding && encoding !== 'identity') {
          return reply.code(415).send({ error: 'unsupported_encoding' });
        }

        let body: unknown;
        try {
          // Fastify's parser rejects __proto__ and constructor.prototype keys (prototype-poisoning protection).
          body = await new Promise<unknown>((resolve, reject) =>
            parseJson(req, raw.toString('utf8'), (err, value) => (err ? reject(err) : resolve(value))),
          );
        } catch {
          return reply.code(400).send({ error: 'invalid_json' });
        }
        const parsed = parseBatch(body);
        if (!parsed.ok) {
          return reply.code(400).send({ error: 'invalid_batch', issues: parsed.issues.slice(0, 20) });
        }
        const { envelope } = parsed;
        if (envelope.app.id !== auth.appId) return reply.code(403).send({ error: 'app_mismatch' });

        const appRecord = await deps.store.apps.get(auth.appId);
        if (envelope.mode === 'audit' && appRecord?.mode !== 'audit') {
          return reply.code(400).send({ error: 'audit_mode_disabled' });
        }

        const now = Date.now();
        const skew = now - Date.parse(envelope.sentAt);
        const shift = Math.abs(skew) > MAX_SKEW_MS ? correction(`${auth.appId}:${envelope.source.instance}`, skew) : 0;
        if (shift !== 0) req.log.warn({ skewMs: skew }, 'clock skew corrected for batch');

        const rejected = parsed.errors.map((e) => ({ index: e.index, reason: e.reason }));
        // parseBatch keeps valid events in order; recover each one's position in the submitted array.
        const invalid = new Set(rejected.map((r) => r.index));
        const submitted = (body as { events: unknown[] }).events.length;
        const positions: number[] = [];
        for (let i = 0; i < submitted; i++) if (!invalid.has(i)) positions.push(i);

        // Never older than raw retention (partitions further back are dropped).
        const keepDays = Math.min(ACCEPT_BACK_DAYS, appRecord?.rawRetentionDays ?? ACCEPT_BACK_DAYS);
        const oldest = now - (keepDays - 1) * 86_400_000;
        // Events written to gauges must also fit the gauge table's shorter window, or the insert would fail the batch.
        const gaugeDays = Math.min(keepDays, RETENTION_DAYS.gauges as number);
        const oldestGauge = now - (gaugeDays - 1) * 86_400_000;
        const items: IngestItem[] = [];
        parsed.events.forEach((event, i) => {
          const index = positions[i]!;
          const ts = event.ts + shift;
          const gaugeType =
            event.type === 'gauge_window' || event.type === 'invalid_request_warning' || event.type === 'app_info';
          if (ts < (gaugeType ? oldestGauge : oldest)) rejected.push({ index, reason: 'too_old' });
          else if (ts > now + MAX_FUTURE_MS) rejected.push({ index, reason: 'in_future' });
          else items.push({ index, event: shift === 0 ? event : { ...event, ts } });
        });

        const periods = await deps.store.salts.livePeriods(auth.appId, new Date());
        let audit: Audit | undefined;
        if (envelope.mode === 'audit' && deps.config.auditKey) {
          const days = await deps.store.settings.get(auth.appId, 'audit_retention_days');
          const auditDays = Math.min(90, Math.max(1, days ?? 30));
          // Audit rows only within audit retention (older partitions don't exist).
          audit = { cipher: auditCipher(deps.config.auditKey), oldestMs: now - (auditDays - 1) * 86_400_000 };
        }
        const context: IngestContext = {
          appId: auth.appId,
          env: envelope.app.env,
          release: envelope.app.release,
          instance: envelope.source.instance,
          shards: envelope.source.shards,
          sdkVersion: `${envelope.sdk.name}@${envelope.sdk.version}`.slice(0, 96),
          livePeriods: periods,
          now: new Date(now),
          mirror: deps.analytics !== undefined,
        };
        const sealed = items.map((item) => sealActor(item, audit));
        let result: WriteResult;
        try {
          result = await deps.store.ingest.write(context, sealed);
        } catch (error) {
          const code = deps.store.refusedInput(error);
          if (code === undefined) throw error;
          req.log.warn({ code }, 'a value in the batch was refused by the database; writing it event by event');
          result = await deps.store.ingest.writeEach(context, sealed);
        }
        // Once the store has the batch: queue accepted rows for ClickHouse and the sink (never blocks or fails ingest).
        if (result.mirror) deps.analytics?.mirror(result.mirror);
        if (deps.sink) {
          const refused = new Set(result.rejected.map((r) => r.index));
          deps.sink.push(
            { appId: auth.appId, env: envelope.app.env, release: envelope.app.release },
            items.filter((i) => !refused.has(i.index)).map((i) => i.event),
          );
        }
        // Live tiles count by when things happened, so backfilled batches never look live, and only what this batch
        // stored, so a retried one is not counted twice.
        for (const { event } of items) {
          if (event.type !== 'interaction' && event.type !== 'message_command') continue;
          if (event.ts < now - 15 * 60_000 || !result.stored.has(event.id.toLowerCase())) continue;
          deps.live.bump(auth.appId, event.ts, event.weight, event.outcome === 'ok' ? 0 : event.weight);
        }
        const allRejected = [...rejected, ...result.rejected].sort((a, b) => a.index - b.index);
        if (allRejected.length > 0) {
          const reasons: Record<string, number> = {};
          for (const { reason } of allRejected) reasons[reason] = (reasons[reason] ?? 0) + 1;
          req.log.warn({ instance: envelope.source.instance.slice(0, 96), reasons }, 'events rejected');
        }
        return reply.code(202).send({
          accepted: result.accepted,
          duplicates: result.duplicates,
          rejected: allRejected,
        });
      } finally {
        inFlight--;
      }
    },
  );
}
