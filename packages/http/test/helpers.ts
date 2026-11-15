import { parseBatch } from '@shardlens/schema';
import type { APIChatInputApplicationCommandInteraction } from 'discord-api-types/v10';
import { vi } from 'vitest';
import { createShardlensHttp, type ShardlensHttp, type ShardlensHttpOptions } from '../src/index.js';

export const APP_ID = '1234567890123456789';
export const GUILD_ID = '112233445566778899';
export const USER_ID = '334455667788990011';
const SALT_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
/** Shaped like an interaction token, and made up. */
export const TOKEN = Buffer.from('interaction:1234567890123456789:made-up-for-these-tests').toString('base64url');

/** A salt period label, `offset` months from now. */
export function month(offset = 0) {
  const d = new Date();
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
  return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A snowflake whose timestamp is `msAgo` milliseconds in the past. */
export function snowflake(msAgo = 0) {
  return ((BigInt(Date.now() - msAgo) - 1_420_070_400_000n) << 22n).toString();
}

interface FakeCollectorOptions {
  mode?: 'privacy' | 'audit';
  /** Answers the nth settings request (from 0) itself, for example with a promise that never settles. */
  config?: (n: number) => Promise<Response> | undefined;
  /** Salt periods served on the nth settings request. Default: this month and the previous one. */
  salts?: (n: number) => string[];
}

/** A collector that checks every batch against the wire schema and keeps what it received. */
function fakeCollector({ mode = 'privacy', config, salts }: FakeCollectorOptions = {}) {
  const batches: { events: Record<string, unknown>[]; raw: string }[] = [];
  const violations: unknown[] = [];
  let configs = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/config')) {
      const n = configs++;
      const answer = config?.(n);
      if (answer) return answer;
      return Response.json({
        v: 1,
        appId: APP_ID,
        mode,
        saltPeriod: 'month',
        salts: (salts?.(n) ?? [month(0), month(-1)]).map((period) => ({ period, salt: SALT_B64 })),
        sampling: {},
        serverTime: new Date().toISOString(),
      });
    }
    const raw = await new Response(
      new Blob([init?.body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    const body = JSON.parse(raw) as { events: Record<string, unknown>[] };
    const parsed = parseBatch(body);
    if (!parsed.ok) violations.push(parsed.issues);
    else if (parsed.errors.length > 0) violations.push(parsed.errors);
    batches.push({ events: body.events, raw });
    return Response.json({ accepted: body.events.length, duplicates: 0, rejected: [] }, { status: 202 });
  });
  const events = (type?: string) => batches.flatMap((b) => b.events).filter((e) => !type || e.type === type);
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    spy: fetchImpl,
    events,
    violations,
    configRequests: () => configs,
    raw: () => batches.map((b) => b.raw).join(),
  };
}

export function slash(
  overrides: Partial<APIChatInputApplicationCommandInteraction> = {},
): APIChatInputApplicationCommandInteraction {
  return {
    id: snowflake(120),
    application_id: APP_ID,
    type: 2,
    token: TOKEN,
    version: 1,
    locale: 'en-GB',
    guild_locale: 'en-US',
    guild_id: GUILD_ID,
    guild: { id: GUILD_ID, locale: 'en-US', features: [] },
    channel: { id: '223344556677889900', type: 0 },
    channel_id: '223344556677889900',
    app_permissions: '0',
    entitlements: [],
    authorizing_integration_owners: { 0: GUILD_ID },
    context: 0,
    attachment_size_limit: 8_388_608,
    member: {
      user: { id: USER_ID, username: 'tester', discriminator: '0', global_name: 'Tester', avatar: null },
      roles: [],
      permissions: '8',
      joined_at: '2024-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
      flags: 0,
    },
    data: {
      id: '445566778899001122',
      name: 'ticket',
      type: 1,
      options: [
        {
          name: 'open',
          type: 1,
          options: [
            { name: 'category', type: 3, value: 'billing' },
            { name: 'reason', type: 3, value: `my card 4111-1111-1111-1111 and ${TOKEN}` },
          ],
        },
      ],
    },
    ...overrides,
  } as APIChatInputApplicationCommandInteraction;
}

/** A Workers `ExecutionContext`: collects what is passed to `waitUntil`. */
export class Ctx {
  promises: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>) {
    this.promises.push(promise);
  }
  settle() {
    return Promise.all(this.promises);
  }
}

const lenses: ShardlensHttp[] = [];

/** A lens reporting to a fake collector. Shut down with {@link shutdownLenses} after each test. */
export function setup(options: ShardlensHttpOptions = {}, collector: FakeCollectorOptions = {}) {
  const fake = fakeCollector(collector);
  const lens = createShardlensHttp({
    endpoint: 'https://collector.test',
    apiKey: 'slk_ingest_test',
    fetch: fake.fetch,
    logger: { warn: () => undefined },
    ...options,
  });
  lenses.push(lens);
  return { collector: fake, lens };
}

export async function shutdownLenses() {
  await Promise.all(lenses.splice(0).map((l) => l.shutdown({ timeoutMs: 50 })));
}
