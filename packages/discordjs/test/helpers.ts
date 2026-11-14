import { parseBatch } from '@shardlens/schema';
import { Client, GatewayIntentBits } from 'discord.js';

/** Every schema violation seen by any fake collector: the contract test asserts this stays empty. */
export const contractViolations: unknown[] = [];

export const APP_ID = '1234567890123456789';
export const GUILD_ID = '112233445566778899';
export const CHANNEL_ID = '223344556677889900';
export const USER_ID = '334455667788990011';
export const AVATAR = 'a_0123456789abcdef0123456789abcdef';
const CMD_ID = '445566778899001122';
export const SALT_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
/** A fake token, assembled from parts so secret scanners don't mistake the fixture for a real one. */
export const BOT_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'Cl2FMQ', 'ZnCjm1XVW7vRze4b7Cq4se7kKWsAbCdEfGh'].join('.');

/** A snowflake for "now", so latency maths works. */
export function snowflake(at = Date.now(), salt = 0): string {
  return (((BigInt(at) - 1420070400000n) << 22n) + BigInt(salt)).toString();
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

interface SentBatch {
  mode: string;
  events: (Record<string, unknown> & { type: string; id: string })[];
  raw: string;
}

/** Fake collector for the SDK's own HTTP calls. */
export function fakeCollector(mode: 'privacy' | 'audit' = 'privacy') {
  const batches: SentBatch[] = [];
  const erasures: { userHashes: string[]; userId?: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/config')) {
      return Response.json({
        v: 1,
        appId: APP_ID,
        mode,
        saltPeriod: 'month',
        salts: [{ period: currentMonth(), salt: SALT_B64 }],
        sampling: {},
        serverTime: new Date().toISOString(),
      });
    }
    if (url.endsWith('/v1/privacy/erase')) {
      erasures.push(JSON.parse(String(init?.body)) as { userHashes: string[]; userId?: string });
      return Response.json({ erased: 3 });
    }
    const raw = await new Response(
      new Blob([init?.body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    const body = JSON.parse(raw) as { mode: string; events: SentBatch['events'] };
    const parsed = parseBatch(body);
    if (!parsed.ok) contractViolations.push(parsed.issues);
    else if (parsed.errors.length > 0) contractViolations.push(parsed.errors);
    batches.push({ mode: body.mode, events: body.events, raw });
    return Response.json({ accepted: body.events.length, duplicates: 0, rejected: [] }, { status: 202 });
  }) as typeof fetch;
  const events = (type?: string) => batches.flatMap((b) => b.events).filter((e) => !type || e.type === type);
  const raw = () => batches.map((b) => b.raw).join('\n');
  return { fetch: fetchImpl, batches, events, raw, erasures };
}

export type FakeReply = (url: string, init: RequestInit) => unknown;

/** A discord.js client whose HTTP layer is a fake `makeRequest`. Never connects to Discord. */
export function makeDiscordClient(reply: FakeReply) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: {
      makeRequest: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return reply(url, init);
      }) as never,
    },
  });
  client.rest.setToken(BOT_TOKEN);
  return { client, calls };
}

/** An undici-style response like @discordjs/rest's default Node strategy returns: one shared, single-use body. */
export function undiciLikeResponse(status: number, json: unknown): unknown {
  let used = false;
  const text = JSON.stringify(json);
  const read = async () => {
    if (used) throw new TypeError('Body is unusable: Body has already been read');
    used = true;
    return text;
  };
  return {
    body: {
      cancel: async () => {
        used = true;
      },
    },
    async arrayBuffer() {
      return new TextEncoder().encode(await read()).buffer;
    },
    async json() {
      return JSON.parse(await read());
    },
    async text() {
      return read();
    },
    get bodyUsed() {
      return used;
    },
    headers: new Headers({ 'content-type': 'application/json' }),
    status,
    statusText: String(status),
    ok: status >= 200 && status < 300,
  };
}

export function rawSlashCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: snowflake(),
    application_id: APP_ID,
    type: 2,
    token: `aW50ZXJhY3Rpb246${'x'.repeat(60)}`,
    version: 1,
    locale: 'en-GB',
    guild_locale: 'en-US',
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    app_permissions: '0',
    entitlements: [],
    authorizing_integration_owners: { '0': GUILD_ID },
    context: 0,
    member: {
      user: { id: USER_ID, username: 'tester', discriminator: '0', global_name: 'Tester', avatar: AVATAR },
      roles: [],
      permissions: '8',
      joined_at: '2020-01-01T00:00:00.000Z',
      deaf: false,
      mute: false,
      flags: 0,
    },
    data: {
      id: CMD_ID,
      name: 'ticket',
      type: 1,
      options: [
        {
          type: 1,
          name: 'open',
          options: [
            { type: 3, name: 'category', value: 'billing' },
            { type: 3, name: 'reason', value: 'my card 4111 was declined' },
          ],
        },
      ],
    },
    ...overrides,
  };
}

export function rawButton(originInteractionId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...rawSlashCommand(),
    id: snowflake(Date.now(), 7),
    type: 3,
    data: { custom_id: `ticket:close:${GUILD_ID}`, component_type: 2 },
    message: {
      id: snowflake(Date.now(), 9),
      channel_id: CHANNEL_ID,
      author: { id: APP_ID, username: 'bot', discriminator: '0', global_name: null, avatar: null, bot: true },
      content: '',
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      type: 20,
      interaction_metadata: {
        id: originInteractionId,
        type: 2,
        user: { id: USER_ID, username: 'tester', discriminator: '0', global_name: null, avatar: null },
        authorizing_integration_owners: { '0': GUILD_ID },
      },
    },
    ...overrides,
  };
}

export function rawGuild(overrides: Record<string, unknown> = {}) {
  return {
    id: GUILD_ID,
    name: 'Test <script>alert(1)</script> server',
    icon: null,
    owner_id: USER_ID,
    afk_timeout: 300,
    verification_level: 1,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    roles: [],
    emojis: [],
    stickers: [],
    features: ['COMMUNITY'],
    mfa_level: 0,
    system_channel_flags: 0,
    premium_tier: 1,
    premium_subscription_count: 3,
    preferred_locale: 'en-GB',
    nsfw_level: 0,
    member_count: 42,
    joined_at: new Date().toISOString(),
    large: false,
    channels: [
      { id: CHANNEL_ID, type: 0, name: 'general', position: 0, permission_overwrites: [] },
      { id: snowflake(Date.now(), 3), type: 2, name: 'voice', position: 1, permission_overwrites: [] },
    ],
    members: [],
    ...overrides,
  };
}
