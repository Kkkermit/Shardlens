// A small fake of Discord's gateway (v10, JSON, no compression) and REST API, enough to run an unmodified discord.js
// bot against it: READY and GUILD_CREATE for three servers, then the scripted scenario SIM_BOT names. Interactions
// are refused with 10062 once older than 3 seconds, like Discord. One gateway connection, shard [0, 1].
// Control endpoints: GET /_sim/status, POST /_sim/continue (resumes a scenario paused with `world.pause(name)`).
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { scenarios } from './scenarios.mjs';

const PORT = Number(process.env.SIM_PORT);
const BOT = process.env.SIM_BOT;
const scenario = scenarios[BOT];
if (!scenario) throw new Error(`unknown SIM_BOT ${BOT}`);

const EPOCH = 1420070400000n;
let inc = 0n;
function snowflake(at = Date.now()) {
  inc = (inc + 1n) % 4096n;
  return (((BigInt(at) - EPOCH) << 22n) | inc).toString();
}
const createdAt = (id) => Number((BigInt(id) >> 22n) + EPOCH);
const hex = (n) => randomBytes(n).toString('hex');

const APP_ID = scenario.appId;
const botUser = {
  id: APP_ID,
  username: 'SimBot',
  discriminator: '0',
  global_name: null,
  avatar: null,
  bot: true,
  flags: 0,
};
const owner = {
  id: '190000000000000001',
  username: 'sim_owner',
  discriminator: '0',
  global_name: 'Owner',
  avatar: null,
};

const users = Array.from({ length: 14 }, (_, i) => ({
  id: String(200000000000000000n + BigInt(i + 1) * 1_000_003n),
  username: `simuser${String(i + 1).padStart(2, '0')}`,
  discriminator: '0',
  global_name: `Sim Person ${i + 1}`,
  avatar: hex(16),
  public_flags: 0,
}));
const admins = new Set([users[0].id, users[1].id]);
// Discord's usual @everyone permissions: view, send, embed, attach, read history, react. Sapphire silently ignores
// messages in channels where the bot can't send.
const EVERYONE = String(1024 + 2048 + 16384 + 32768 + 65536 + 64);

function makeGuild(n) {
  const id = String(300000000000000000n + BigInt(n) * 7_000_001n);
  const adminRole = String(BigInt(id) + 1n);
  const role = (roleId, name, permissions, position) => ({
    id: roleId,
    name,
    permissions,
    position,
    color: 0,
    hoist: false,
    managed: false,
    mentionable: false,
    flags: 0,
  });
  const channel = (offset, type, name) => ({
    id: String(BigInt(id) + offset),
    type,
    name,
    position: Number(offset - 10n),
    permission_overwrites: [],
    guild_id: id,
  });
  return {
    id,
    name: `Sim Server ${n}`,
    icon: null,
    owner_id: owner.id,
    afk_timeout: 300,
    verification_level: 1,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    roles: [role(id, '@everyone', EVERYONE, 0), role(adminRole, 'Admin', '8', 1)],
    emojis: [],
    stickers: [],
    features: n === 1 ? ['COMMUNITY'] : [],
    mfa_level: 0,
    system_channel_flags: 0,
    premium_tier: n === 1 ? 2 : 0,
    premium_subscription_count: n === 1 ? 7 : 0,
    preferred_locale: n === 2 ? 'de' : 'en-US',
    nsfw_level: 0,
    member_count: 40 * n + 3,
    joined_at: new Date(Date.now() - n * 86_400_000).toISOString(),
    large: false,
    unavailable: false,
    channels: [channel(10n, 0, 'general'), channel(11n, 0, 'support'), channel(12n, 2, 'voice')],
    threads: [],
    // The bot has the admin role.
    members: [
      { user: botUser, roles: [adminRole], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 },
    ],
    voice_states: [],
    presences: [],
    stage_instances: [],
    guild_scheduled_events: [],
    soundboard_sounds: [],
    _adminRole: adminRole,
  };
}

const guilds = [makeGuild(1), makeGuild(2), makeGuild(3)];
const lateGuild = makeGuild(4);
const allGuilds = [...guilds, lateGuild];
const wire = ({ _adminRole, ...guild }) => guild;

const registered = (body) => ({
  id: snowflake(),
  application_id: APP_ID,
  version: snowflake(),
  default_member_permissions: null,
  type: 1,
  options: [],
  ...body,
});

const state = {
  phase: 'waiting',
  // Commands the owner registered earlier, with a deploy script that isn't part of the bot process.
  commands: (scenario.registered ?? []).map(([name, type]) => registered({ name, type })),
  messages: new Map(),
  interactions: new Map(),
  unknownRoutes: new Set(),
  callbacks: { ok: 0, late: 0, duplicate: 0 },
  expected: null,
  continue: null,
};

function member(user, guild) {
  return {
    user,
    roles: admins.has(user.id) ? [guild._adminRole] : [],
    joined_at: '2024-01-01T00:00:00.000Z',
    deaf: false,
    mute: false,
    flags: 0,
    pending: false,
    nick: null,
    avatar: null,
    premium_since: null,
    communication_disabled_until: null,
  };
}

let socket;
let seq = 0;
const send = (payload) => socket?.readyState === 1 && socket.send(JSON.stringify(payload));
const dispatch = (t, d) => send({ op: 0, s: ++seq, t, d });

function onIdentify() {
  dispatch('READY', {
    v: 10,
    user: botUser,
    guilds: guilds.map((g) => ({ id: g.id, unavailable: true })),
    session_id: hex(16),
    resume_gateway_url: `ws://127.0.0.1:${PORT}/gateway`,
    shard: [0, 1],
    application: { id: APP_ID, flags: 0 },
    private_channels: [],
    _trace: ['sim'],
  });
  for (const g of guilds) setTimeout(() => dispatch('GUILD_CREATE', wire(g)), 20);
  if (state.phase === 'waiting') {
    state.phase = 'connected';
    setTimeout(() => void runScenario(), Number(process.env.SIM_START_DELAY ?? 6000));
  }
}

function botMessage({ channelId, guildId, content = '', components = [], flags = 0, interactionMetadata, reference }) {
  const msg = {
    id: snowflake(),
    channel_id: channelId,
    ...(guildId ? { guild_id: guildId } : {}),
    author: botUser,
    content,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: interactionMetadata ? 20 : reference ? 19 : 0,
    flags,
    components,
    ...(interactionMetadata ? { interaction_metadata: interactionMetadata } : {}),
  };
  state.messages.set(msg.id, msg);
  return msg;
}

const interactionReply = (it, data = {}) =>
  botMessage({
    channelId: it.channelId,
    guildId: it.guildId,
    content: data.content ?? '',
    components: data.components ?? [],
    flags: data.flags ?? 0,
    interactionMetadata: {
      id: it.id,
      type: it.type,
      user: it.user,
      authorizing_integration_owners: { 0: it.guildId ?? '0' },
    },
  });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  if ((req.headers['content-type'] ?? '').includes('multipart/form-data')) {
    const m = /name="payload_json"\r\n(?:Content-Type: application\/json\r\n)?\r\n([\s\S]*?)\r\n--/.exec(raw);
    return m ? JSON.parse(m[1]) : {};
  }
  return JSON.parse(raw);
}

function json(res, status, body) {
  // Like Discord, a 204 has no body and no content type: discord.js parses JSON by content type.
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function callback({ match: [, id, token], body, query }) {
  const it = state.interactions.get(id);
  if (!it || it.token !== token) return [404, { message: 'Unknown interaction', code: 10062 }];
  if (Date.now() - createdAt(id) > 3_000) {
    state.callbacks.late++;
    return [404, { message: 'Unknown interaction', code: 10062 }];
  }
  if (it.responded) {
    state.callbacks.duplicate++;
    return [400, { message: 'Interaction has already been acknowledged.', code: 40060 }];
  }
  it.responded = body?.type;
  state.callbacks.ok++;
  const message = body?.type === 4 ? interactionReply(it, body.data) : undefined;
  if (query.get('with_response') !== 'true') return [204];
  return [
    200,
    {
      interaction: {
        id: it.id,
        type: it.type,
        activity_instance_id: null,
        response_message_id: message?.id ?? null,
        response_message_loading: false,
        response_message_ephemeral: false,
      },
      resource: message ? { type: body.type, message } : { type: body?.type },
    },
  ];
}

// [method or '*', path pattern, handler returning [status, body]]
const routes = [
  [
    'GET',
    /^\/gateway\/bot$/,
    () => [
      200,
      {
        url: `ws://127.0.0.1:${PORT}/gateway`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 996, reset_after: 80_000_000, max_concurrency: 1 },
      },
    ],
  ],
  [
    'GET',
    /^\/(oauth2\/)?applications\/@me$/,
    () => [
      200,
      {
        id: APP_ID,
        name: 'SimBot',
        icon: null,
        description: '',
        bot_public: true,
        bot_require_code_grant: false,
        verify_key: hex(32),
        flags: 0,
        owner,
        team: null,
        approximate_guild_count: guilds.length,
        approximate_user_install_count: 12,
        bot: botUser,
      },
    ],
  ],
  ['GET', /^\/users\/@me$/, () => [200, botUser]],
  ['GET', /^\/applications\/\d+\/(skus|entitlements)$/, () => [200, []]],
  ['GET', /^\/applications\/\d+\/commands$/, () => [200, state.commands]],
  [
    'PUT',
    /^\/applications\/\d+\/commands$/,
    ({ body }) => {
      state.commands = (body ?? []).map(registered);
      return [200, state.commands];
    },
  ],
  [
    'POST',
    /^\/applications\/\d+\/commands$/,
    ({ body }) => {
      const created = registered(body);
      state.commands = [...state.commands.filter((c) => c.name !== created.name || c.type !== created.type), created];
      return [201, created];
    },
  ],
  [
    'PATCH',
    /^\/applications\/\d+\/commands\/(\d+)$/,
    ({ match, body }) => {
      const i = state.commands.findIndex((c) => c.id === match[1]);
      if (i < 0) return [404, { message: 'Unknown application command', code: 10063 }];
      state.commands[i] = { ...state.commands[i], ...body };
      return [200, state.commands[i]];
    },
  ],
  [
    'DELETE',
    /^\/applications\/\d+\/commands\/(\d+)$/,
    ({ match }) => {
      state.commands = state.commands.filter((c) => c.id !== match[1]);
      return [204];
    },
  ],
  ['GET', /^\/applications\/\d+\/guilds\/\d+\/commands$/, () => [200, []]],
  ['PUT', /^\/applications\/\d+\/guilds\/\d+\/commands$/, ({ body }) => [200, (body ?? []).map(registered)]],
  ['POST', /^\/interactions\/(\d+)\/([^/]+)\/callback$/, callback],
  [
    // Follow-ups and edits of interaction replies. discord.js sends `@original` URL-encoded.
    '*',
    /^\/webhooks\/\d+\/([^/]+)(\/messages\/(@original|%40original|\d+))?$/,
    ({ match, method, body }) => {
      const it = [...state.interactions.values()].find((i) => i.token === match[1]);
      if (!it) return [404, { message: 'Unknown Webhook', code: 10015 }];
      if (method === 'DELETE') return [204];
      return [200, interactionReply(it, body)];
    },
  ],
  [
    'POST',
    /^\/channels\/(\d+)\/messages$/,
    ({ match, body }) => {
      const guild = allGuilds.find((g) => g.channels.some((c) => c.id === match[1]));
      const message = botMessage({
        channelId: match[1],
        guildId: guild?.id,
        content: body?.content ?? '',
        components: body?.components ?? [],
        reference: body?.message_reference,
      });
      return [200, message];
    },
  ],
  ['POST', /^\/channels\/\d+\/typing$/, () => [204]],
  [
    'POST',
    /^\/users\/@me\/channels$/,
    ({ body }) => [
      200,
      {
        id: snowflake(),
        type: 1,
        recipients: [users.find((u) => u.id === body?.recipient_id) ?? users[0]],
        last_message_id: null,
      },
    ],
  ],
];

async function rest(req, res, path, query) {
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
  for (const [method, pattern, handle] of routes) {
    const match = (method === '*' || method === req.method) && pattern.exec(path);
    if (match) return json(res, ...handle({ match, method: req.method, body, query }));
  }
  state.unknownRoutes.add(`${req.method} ${path}`);
  return json(res, 404, { message: '404: Not Found', code: 0 });
}

const commandId = (name, type = 1) =>
  state.commands.find((c) => c.name === name && (c.type ?? 1) === type)?.id ?? snowflake();
const dmChannel = (user) => ({ id: String(BigInt(user.id) + 5n), type: 1, recipients: [user] });

function interactionBase(type, user, guild, data, extra = {}) {
  const id = snowflake();
  const token = `aW50ZXJhY3Rpb246${hex(40)}`;
  const channel = guild ? guild.channels[0] : dmChannel(user);
  const where = guild
    ? {
        guild_id: guild.id,
        guild_locale: guild.preferred_locale,
        guild: { id: guild.id, locale: guild.preferred_locale, features: guild.features },
        member: { ...member(user, guild), permissions: admins.has(user.id) ? '8' : EVERYONE },
      }
    : { user };
  state.interactions.set(id, { id, token, type, user, guildId: guild?.id, channelId: channel.id });
  return {
    id,
    application_id: APP_ID,
    type,
    data,
    token,
    version: 1,
    locale: user.id.endsWith('7') ? 'fr' : 'en-GB',
    app_permissions: '2251799813685247',
    entitlements: [],
    authorizing_integration_owners: { 0: guild ? guild.id : '0' },
    context: guild ? 0 : 1,
    attachment_size_limit: 10_485_760,
    channel_id: channel.id,
    channel: { ...channel },
    ...where,
    ...extra,
  };
}

function interact(...args) {
  const payload = interactionBase(...args);
  dispatch('INTERACTION_CREATE', payload);
  return payload.id;
}

/** What a scenario can do and see. */
const world = {
  users,
  guilds,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  /** Runs a slash command; returns the interaction ID. */
  slash: (user, guild, name, options = []) => interact(2, user, guild, { id: commandId(name), name, type: 1, options }),
  autocomplete: (user, guild, name, options) =>
    interact(4, user, guild, { id: commandId(name), name, type: 1, options }),
  userMenu: (user, guild, name, target) =>
    interact(2, user, guild, {
      id: commandId(name, 2),
      name,
      type: 2,
      target_id: target.id,
      resolved: {
        users: { [target.id]: target },
        ...(guild
          ? { members: { [target.id]: { ...member(target, guild), user: undefined, permissions: EVERYONE } } }
          : {}),
      },
    }),
  messageMenu: (user, guild, name, message) =>
    interact(2, user, guild, {
      id: commandId(name, 3),
      name,
      type: 3,
      target_id: message.id,
      resolved: { messages: { [message.id]: message } },
    }),
  /** Clicks a component on a message the bot sent. */
  component: (user, guild, message, customId, componentType = 2, values) =>
    interact(
      3,
      user,
      guild,
      { custom_id: customId, component_type: componentType, ...(values ? { values } : {}) },
      { message },
    ),
  modalSubmit: (user, guild, customId, fields) =>
    interact(5, user, guild, {
      custom_id: customId,
      components: Object.entries(fields).map(([id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id: id, value }],
      })),
    }),
  say(user, guild, content) {
    const channel = guild ? guild.channels[0] : dmChannel(user);
    dispatch('MESSAGE_CREATE', {
      id: snowflake(),
      channel_id: channel.id,
      ...(guild ? { guild_id: guild.id, member: { ...member(user, guild), user: undefined } } : {}),
      // discord.js 14.28 needs it to create a DM channel it hasn't seen.
      channel_type: channel.type,
      author: user,
      content,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      type: 0,
      flags: 0,
      components: [],
    });
  },
  joinGuild() {
    guilds.push(lateGuild);
    dispatch('GUILD_CREATE', wire(lateGuild));
  },
  leaveGuild(guild) {
    guilds.splice(guilds.indexOf(guild), 1);
    dispatch('GUILD_DELETE', { id: guild.id });
  },
  /** Bot messages that answered an interaction. */
  repliesTo: (id) => [...state.messages.values()].filter((m) => m.interaction_metadata?.id === id),
  botMessagesIn: (channelId) => [...state.messages.values()].filter((m) => m.channel_id === channelId),
  responded: (id) => state.interactions.get(id)?.responded,
  /** Waits until told to continue (POST /_sim/continue), so a step outside the sim can happen. */
  pause(name) {
    state.phase = `paused:${name}`;
    return new Promise((resolve) => {
      state.continue = resolve;
    });
  },
};

async function runScenario() {
  state.phase = 'running';
  try {
    state.expected = await scenario.run(world);
    state.phase = 'done';
  } catch (error) {
    state.phase = `failed: ${error.stack ?? error}`;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/_sim/status') {
      return json(res, 200, {
        phase: state.phase,
        callbacks: state.callbacks,
        unknownRoutes: [...state.unknownRoutes],
        expected: state.expected,
        users: users.map(({ id, username, global_name, avatar }) => ({ id, username, global_name, avatar })),
        guilds: allGuilds.map(({ id, name }) => ({ id, name })),
        interactionTokens: [...state.interactions.values()].map((i) => i.token),
      });
    }
    if (url.pathname === '/_sim/continue' && req.method === 'POST') {
      state.phase = 'running';
      state.continue?.();
      return json(res, 200, { ok: true });
    }
    const api = /^\/api\/v10(\/.*)$/.exec(url.pathname);
    if (api) return await rest(req, res, api[1], url.searchParams);
    json(res, 404, { message: 'not found' });
  } catch (error) {
    console.error('sim error', error);
    json(res, 500, { message: String(error) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (!req.url?.startsWith('/gateway')) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => {
    socket = ws;
    seq = 0;
    send({ op: 10, d: { heartbeat_interval: 41_250 } });
    ws.on('message', (raw) => {
      const p = JSON.parse(String(raw));
      if (p.op === 1) send({ op: 11 });
      else if (p.op === 2) onIdentify();
      else if (p.op === 6) dispatch('RESUMED', {});
    });
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake Discord for ${BOT} on ${PORT}`));
