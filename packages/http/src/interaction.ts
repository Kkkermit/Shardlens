import {
  avatarHash,
  compact,
  cutText,
  MAX_CUSTOM_ID_LENGTH,
  recordedOptionValue,
  redactSecrets,
  uuidv7,
} from '@shardlens/core';

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

/** The `data` of a raw interaction: the command, its options, or the component or modal's custom ID. */
export interface RawInteractionData {
  id?: string | undefined;
  name?: string | undefined;
  type?: number | undefined;
  guild_id?: string | undefined;
  options?: readonly RawOption[] | undefined;
  custom_id?: string | undefined;
  component_type?: number | undefined;
}

/** A command option as Discord sends it; subcommands and groups hold their own `options`. */
export interface RawOption {
  name: string;
  type: number;
  value?: unknown;
  focused?: boolean | undefined;
  options?: readonly RawOption[] | undefined;
}

/** The user who ran an interaction. Only the ID is read, plus username and avatar in audit mode. */
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

/**
 * The wire format's snowflake rule (`Snowflake` in `@shardlens/schema`): below 2^63, the largest the collector stores.
 * A looser check would let through an ID the collector refuses, and with it the whole event.
 */
const SNOWFLAKE = /^(?:\d{17,18}|[1-8]\d{18}|9[01]\d{17})$/;

export const snowflake = (v: unknown): string | undefined => (typeof v === 'string' && SNOWFLAKE.test(v) ? v : undefined);
const integer = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : undefined);

/** When Discord created the interaction, from its ID; now, for an ID that isn't one. */
function snowflakeTime(id: unknown): number {
  const valid = snowflake(id);
  return valid === undefined ? Date.now() : Number((BigInt(valid) >> 22n) + DISCORD_EPOCH);
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
  for (const o of Array.isArray(options) ? (options as readonly RawOption[]) : []) {
    if (typeof o !== 'object' || o === null) continue;
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

const short = (v: unknown, n: number) => (typeof v === 'string' && v.length > 0 ? cutText(v, n) : undefined);

/** A custom ID as it is recorded: secrets redacted, then the bot's normaliser (or the default one), then capped. */
export function recordedCustomId(v: unknown, options: Pick<DescribeOptions, 'normaliseCustomId'>): string {
  return cutText(options.normaliseCustomId(redactSecrets(String(v ?? ''))), MAX_CUSTOM_ID_LENGTH);
}

/**
 * Turns a raw interaction into the wire fields Shardlens keeps, exactly as the discord.js adapter does. Returns
 * `undefined` for PING, unknown types and interactions without a user, which the collector would refuse. The user ID
 * is returned separately: it is hashed before it is queued.
 */
export function describeRawInteraction(
  i: RawInteraction,
  options: DescribeOptions,
): { fields: InteractionFields; userId: string } | undefined {
  const user = i.member?.user ?? i.user;
  if (typeof user?.id !== 'string') return undefined;
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
    channelType: integer(i.channel?.type),
    locale: (short(i.locale, 10) ?? 'unknown') as string,
    guildLocale: short(i.guild_locale, 10),
    memberTier: memberTier(i),
    premium: (i.entitlements?.length ?? 0) > 0,
    options: [] as string[],
    actor:
      options.mode === 'audit' && snowflake(user.id)
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
        if (!options.captureOptionValues.has(o.name) || o.name.length > 32) continue;
        const recorded = recordedOptionValue(o.value, o.type);
        if (recorded !== undefined) values[o.name] = recorded;
      }
      fields = {
        kind: 'chat_input',
        command: short(data.name, 32),
        group: short(path.group, 32),
        sub: short(path.sub, 32),
        commandId: snowflake(data.id),
        commandScope,
        options: all.map((o) => cutText(String(o.name), 32)).slice(0, 25),
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
      options: focused ? [cutText(String(focused), 32)] : [],
    };
  } else if (i.type === MESSAGE_COMPONENT) {
    // `name` holds the subcommand too: `ticket open`.
    const name = i.message?.interaction?.name;
    const source = typeof name === 'string' ? name.split(' ')[0] : undefined;
    fields = {
      kind: data.component_type === 2 ? 'button' : 'select',
      customId: recordedCustomId(data.custom_id, options),
      componentType: integer(data.component_type),
      sourceCommand: short(source, 32),
    };
  } else if (i.type === MODAL_SUBMIT) {
    fields = { kind: 'modal_submit', customId: recordedCustomId(data.custom_id, options) };
  }
  if (!fields) return undefined;
  return { fields: compact({ ...common, ...fields }) as unknown as InteractionFields, userId: user.id };
}

const MODAL = 9;

/**
 * Reads the interaction callback type and ephemeral flag from what the handler returned, and the custom ID of a modal
 * it opened, as the bot wrote it.
 */
export function describeResponse(body: unknown): {
  responseType?: number | undefined;
  deferred?: boolean | undefined;
  ephemeral?: boolean | undefined;
  modalCustomId?: string | undefined;
} {
  if (typeof body !== 'object' || body === null) return {};
  const type = integer((body as { type?: unknown }).type);
  const data = (body as { data?: { flags?: unknown; custom_id?: unknown } | null }).data;
  if (type === undefined) return {};
  return compact({
    responseType: type,
    deferred: type === 5 || type === 6,
    ephemeral: Number.isSafeInteger(data?.flags) ? ((data?.flags as number) & 64) !== 0 : undefined,
    modalCustomId: type === MODAL && typeof data?.custom_id === 'string' ? data.custom_id : undefined,
  });
}
