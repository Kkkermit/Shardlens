import { avatarHash, compact, MAX_CUSTOM_ID_LENGTH, redactSecrets, uuidv7 } from '@shardlens/core';

/**
 * The parts of a raw Discord interaction payload Shardlens reads. `APIInteraction` from `discord-api-types` (and the
 * JSON Discord posts to your Interactions Endpoint URL) fits this shape.
 */
export interface RawInteraction {
  id: string;
  type: number;
  data?: RawInteractionData | undefined;
  guild_id?: string | undefined;
  channel?: { type?: number | undefined } | undefined;
  member?: { user?: RawUser | undefined; permissions?: string | undefined } | undefined;
  user?: RawUser | undefined;
  locale?: string | undefined;
  guild_locale?: string | undefined;
  context?: number | undefined;
  authorizing_integration_owners?: Partial<Record<string, string>> | undefined;
  entitlements?: readonly unknown[] | undefined;
  message?: { interaction?: { name?: string | undefined } | undefined } | undefined;
}

export interface RawInteractionData {
  id?: string | undefined;
  name?: string | undefined;
  type?: number | undefined;
  guild_id?: string | undefined;
  options?: readonly RawOption[] | undefined;
  custom_id?: string | undefined;
  component_type?: number | undefined;
}

export interface RawOption {
  name: string;
  type: number;
  value?: unknown;
  focused?: boolean | undefined;
  options?: readonly RawOption[] | undefined;
}

export interface RawUser {
  id: string;
  username?: string | undefined;
  avatar?: string | null | undefined;
}

interface DescribeOptions {
  mode: 'privacy' | 'audit';
  auditIncludeProfile: boolean;
  captureOptionValues: ReadonlySet<string>;
  normaliseCustomId: (customId: string) => string;
}

/** Interaction fields Shardlens keeps, before the outcome and the hashed user are added. */
type InteractionFields = Record<string, unknown> & { id: string; ts: number; kind: string; command?: string };

const DISCORD_EPOCH = 1_420_070_400_000n;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const APPLICATION_COMMAND_AUTOCOMPLETE = 4;
const MODAL_SUBMIT = 5;

function snowflakeTime(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return Date.now();
  }
}

function memberTier(i: RawInteraction): 'admin' | 'manager' | 'member' | 'dm' {
  if (!i.guild_id) return 'dm';
  let bits = 0n;
  try {
    bits = BigInt(i.member?.permissions ?? '0');
  } catch {
    bits = 0n;
  }
  if (bits & ADMINISTRATOR) return 'admin';
  if (bits & MANAGE_GUILD) return 'manager';
  return 'member';
}

function leaves(options: readonly RawOption[] | undefined, path: { group?: string; sub?: string } = {}) {
  const out: RawOption[] = [];
  for (const o of options ?? []) {
    if (o.type === SUB_COMMAND_GROUP) {
      path.group = o.name;
      out.push(...leaves(o.options, path));
    } else if (o.type === SUB_COMMAND) {
      path.sub = o.name;
      out.push(...leaves(o.options, path));
    } else out.push(o);
  }
  return out;
}

const snowflake = (v: unknown) => (typeof v === 'string' && /^\d{17,20}$/.test(v) ? v : undefined);
const short = (v: unknown, n: number) => (typeof v === 'string' && v.length > 0 ? v.slice(0, n) : undefined);
const customId = (v: unknown, options: DescribeOptions) =>
  options.normaliseCustomId(redactSecrets(String(v ?? ''))).slice(0, MAX_CUSTOM_ID_LENGTH);

/**
 * Turns a raw interaction into the wire fields Shardlens keeps, exactly as the discord.js adapter does. Returns
 * `undefined` for PING and unknown types. The user ID is returned separately: it is hashed before it is queued.
 */
export function describeRawInteraction(
  i: RawInteraction,
  options: DescribeOptions,
): { fields: InteractionFields; userId: string | undefined } | undefined {
  const user = i.member?.user ?? i.user;
  const owners = i.authorizing_integration_owners ?? {};
  const guildInstalled = owners['0'] !== undefined;
  const userInstalled = owners['1'] !== undefined;
  const ts = snowflakeTime(i.id);
  const context = i.context === 0 || i.context === 1 || i.context === 2 ? i.context : undefined;
  const common = compact({
    id: uuidv7(ts),
    ts,
    type: 'interaction',
    context,
    install: guildInstalled && userInstalled ? 'both' : userInstalled ? 'user' : 'guild',
    guild: snowflake(i.guild_id),
    channelType: typeof i.channel?.type === 'number' ? i.channel.type : undefined,
    locale: (short(i.locale, 10) ?? 'unknown') as string,
    guildLocale: short(i.guild_locale, 10),
    memberTier: memberTier(i),
    premium: (i.entitlements?.length ?? 0) > 0,
    options: [] as string[],
    actor:
      options.mode === 'audit' && user
        ? compact({
            userId: user.id,
            username: options.auditIncludeProfile ? short(user.username, 64) : undefined,
            avatar: options.auditIncludeProfile ? avatarHash(user.avatar) : undefined,
          })
        : undefined,
  });
  const data = i.data ?? {};
  const commandScope = data.guild_id ? 'guild' : 'global';

  let fields: Record<string, unknown> | undefined;
  if (i.type === APPLICATION_COMMAND) {
    if (data.type === 1 || data.type === undefined) {
      const path: { group?: string; sub?: string } = {};
      const all = leaves(data.options, path);
      const values: Record<string, string | number | boolean> = {};
      for (const o of all) {
        if (!options.captureOptionValues.has(o.name)) continue;
        if (typeof o.value === 'string') values[o.name] = redactSecrets(o.value).slice(0, 100);
        else if (typeof o.value === 'number' || typeof o.value === 'boolean') values[o.name] = o.value;
      }
      fields = {
        kind: 'chat_input',
        command: short(data.name, 32),
        group: path.group?.slice(0, 32),
        sub: path.sub?.slice(0, 32),
        commandId: snowflake(data.id),
        commandScope,
        options: all.map((o) => o.name.slice(0, 32)).slice(0, 25),
        optionValues: Object.keys(values).length > 0 ? values : undefined,
      };
    } else if (data.type === 2 || data.type === 3) {
      fields = {
        kind: data.type === 2 ? 'user_context' : 'message_context',
        command: short(data.name, 32),
        commandId: snowflake(data.id),
        commandScope,
      };
    } else if (data.type === 4) {
      fields = { kind: 'primary_entry_point', command: short(data.name, 32), commandId: snowflake(data.id) };
    }
  } else if (i.type === APPLICATION_COMMAND_AUTOCOMPLETE) {
    const focused = leaves(data.options).find((o) => o.focused)?.name;
    fields = {
      kind: 'autocomplete',
      command: short(data.name, 32),
      commandId: snowflake(data.id),
      options: focused ? [focused.slice(0, 32)] : [],
    };
  } else if (i.type === MESSAGE_COMPONENT) {
    const source = i.message?.interaction?.name?.split(' ')[0];
    fields = {
      kind: data.component_type === 2 ? 'button' : 'select',
      customId: customId(data.custom_id, options),
      componentType: data.component_type,
      sourceCommand: short(source, 32),
    };
  } else if (i.type === MODAL_SUBMIT) {
    fields = { kind: 'modal_submit', customId: customId(data.custom_id, options) };
  }
  if (!fields) return undefined;
  return { fields: compact({ ...common, ...fields }) as unknown as InteractionFields, userId: user?.id };
}

/** Reads the interaction callback type and ephemeral flag from what the handler returned. */
export function describeResponse(body: unknown): {
  responseType?: number | undefined;
  deferred?: boolean | undefined;
  ephemeral?: boolean | undefined;
} {
  if (typeof body !== 'object' || body === null) return {};
  const type = (body as { type?: unknown }).type;
  const flags = (body as { data?: { flags?: unknown } }).data?.flags;
  if (typeof type !== 'number') return {};
  return compact({
    responseType: type,
    deferred: type === 5 || type === 6,
    ephemeral: typeof flags === 'number' ? (flags & 64) !== 0 : undefined,
  });
}
