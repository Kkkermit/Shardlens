import {
  compact,
  cutText,
  MAX_CUSTOM_ID_LENGTH,
  normaliseCustomId,
  redactSecrets,
  type ShardlensClient,
  uuidv7,
} from '@shardlens/core';
import type { EventInput } from '@shardlens/schema';
import type { Interaction } from 'discord.js';
import type { ShardlensOptions } from './options.js';
import { auditActor, capturedValues, memberTier } from './run-details.js';
import { LruMap, shardForGuild } from './util.js';

type InteractionInput = Extract<EventInput, { type: 'interaction' }>;
type InteractionBase = Omit<InteractionInput, 'user' | 'outcome'>;
type Outcome = InteractionInput['outcome'];

/** How long to wait for a first response (and a wrapped handler) before the interaction row is sent anyway. */
const PENDING_TIMEOUT_MS = 10_000;
const MAX_PENDING = 10_000;

interface ResponseInfo {
  outcome: Outcome;
  ackMs?: number;
  responseType?: number;
  deferred?: boolean;
  ephemeral?: boolean;
  errorCode?: number;
  /** The custom ID of the modal this response opened, as the bot wrote it. */
  modalCustomId?: string;
}

type HandlerState = { state: 'running'; start: number } | { state: 'done'; ms?: number; error?: HandlerError };

interface HandlerError {
  errorClass: string;
  errorCode?: number;
}

interface Pending {
  base: InteractionBase;
  userId: string;
  timer: ReturnType<typeof setTimeout>;
  response?: ResponseInfo;
  handler?: HandlerState;
}

interface Emitted {
  eventId: string;
  command?: string;
}

interface TrackerContext {
  client: ShardlensClient<EventInput>;
  options: ShardlensOptions;
  count: (name: string, error?: unknown) => void;
  shardCount: () => number;
  /** Users whose interactions are never recorded. Owned by the caller, which also applies it to other events. */
  optedOut: ReadonlySet<string>;
}

type FlatOption = { name: string; value?: unknown; type?: number };

/** A custom ID as it is recorded: secrets redacted, then the bot's normaliser (or the default one), then capped. */
function recordedCustomId(customId: string, options: ShardlensOptions): string {
  const normalise = options.normaliseCustomId ?? normaliseCustomId;
  return cutText(normalise(redactSecrets(customId)), MAX_CUSTOM_ID_LENGTH);
}

function flattenOptions(
  data: readonly { name: string; value?: unknown; type?: unknown; options?: readonly unknown[] }[],
): FlatOption[] {
  const out: FlatOption[] = [];
  for (const o of data) {
    if (o.options && o.options.length > 0) out.push(...flattenOptions(o.options as typeof data));
    else if (o.value !== undefined) {
      out.push({ name: o.name, value: o.value, ...(typeof o.type === 'number' ? { type: o.type } : {}) });
    }
  }
  return out;
}

function describeInteraction(
  i: Interaction,
  options: ShardlensOptions,
  shardCount: number,
): InteractionBase | undefined {
  // Keyed by `ApplicationIntegrationType`: 0 for a server install, 1 for a user install. Not the enum itself: some
  // discord.js 14 releases don't export it, and importing a missing name stops an ES module from loading.
  const owners = (i.authorizingIntegrationOwners ?? {}) as unknown as Record<string, unknown>;
  const guildInstalled = owners[0] !== undefined;
  const userInstalled = owners[1] !== undefined;
  const context = i.context;
  const common = compact({
    id: uuidv7(i.createdTimestamp),
    ts: i.createdTimestamp,
    type: 'interaction' as const,
    context: context === 0 || context === 1 || context === 2 ? context : undefined,
    install:
      guildInstalled && userInstalled ? ('both' as const) : userInstalled ? ('user' as const) : ('guild' as const),
    guild: i.guildId ?? undefined,
    channelType: i.channel?.type,
    locale: String(i.locale).slice(0, 10),
    guildLocale: i.guildLocale ? String(i.guildLocale).slice(0, 10) : undefined,
    memberTier: memberTier(i.inGuild(), i.memberPermissions, 'member'),
    premium: (i.entitlements?.size ?? 0) > 0,
    options: [] as string[],
    shard: i.guild?.shardId ?? (i.guildId ? shardForGuild(i.guildId, shardCount) : 0),
    actor: auditActor(i.user, options),
  });

  if (i.isChatInputCommand()) {
    const leaves = flattenOptions(i.options.data);
    return compact({
      ...common,
      kind: 'chat_input' as const,
      command: i.commandName,
      group: i.options.getSubcommandGroup(false) ?? undefined,
      sub: i.options.getSubcommand(false) ?? undefined,
      commandId: i.commandId,
      commandScope: i.commandGuildId ? ('guild' as const) : ('global' as const),
      options: leaves.map((o) => o.name).slice(0, 25),
      optionValues: capturedValues(
        leaves.map((o) => [o.name, o.value, o.type] as const),
        options.captureOptionValues,
      ),
    });
  }
  if (i.isUserContextMenuCommand() || i.isMessageContextMenuCommand()) {
    return compact({
      ...common,
      kind: i.isUserContextMenuCommand() ? ('user_context' as const) : ('message_context' as const),
      command: i.commandName,
      commandId: i.commandId,
      commandScope: i.commandGuildId ? ('guild' as const) : ('global' as const),
    });
  }
  // discord.js 14.18 and older don't have this check; without the guard, every component would fail here.
  if (typeof i.isPrimaryEntryPointCommand === 'function' && i.isPrimaryEntryPointCommand()) {
    return compact({ ...common, kind: 'primary_entry_point' as const, command: i.commandName, commandId: i.commandId });
  }
  if (i.isAutocomplete()) {
    let focused: string | undefined;
    try {
      focused = i.options.getFocused(true).name;
    } catch {
      focused = undefined;
    }
    return compact({
      ...common,
      kind: 'autocomplete' as const,
      command: i.commandName,
      commandId: i.commandId,
      options: focused ? [focused] : [],
    });
  }
  if (i.isMessageComponent()) {
    return compact({
      ...common,
      kind: i.isButton() ? ('button' as const) : ('select' as const),
      customId: recordedCustomId(i.customId, options),
      componentType: i.componentType,
    });
  }
  if (i.isModalSubmit()) {
    return compact({
      ...common,
      kind: 'modal_submit' as const,
      customId: recordedCustomId(i.customId, options),
    });
  }
  return undefined;
}

/**
 * Follows each interaction from `interactionCreate` to its first response (seen through the REST callback route) and,
 * when the handler is wrapped, to the handler's end, so latency, outcome and handler time land on one row.
 */
export class InteractionTracker {
  readonly #ctx: TrackerContext;
  readonly #pending = new Map<string, Pending>();
  /** interaction ID → command name, to attribute component clicks to the command that created the message. */
  readonly #sourceCommand = new LruMap<string, string>(20_000);
  /** interaction ID → emitted event, for handler errors that arrive after the row was sent. */
  readonly #emitted = new LruMap<string, Emitted>(5_000);

  constructor(ctx: TrackerContext) {
    this.#ctx = ctx;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Drops a user's interactions that have not been sent yet, such as the one they opted out with. */
  dropPending(userId: string): void {
    for (const [id, p] of this.#pending) {
      if (p.userId !== userId) continue;
      clearTimeout(p.timer);
      this.#pending.delete(id);
    }
  }

  /** Starts tracking an interaction. Safe to call more than once (the listener and `wrap()` both call it). */
  observe(i: Interaction): void {
    if (this.#pending.has(i.id) || this.#emitted.has(i.id) || this.#ctx.optedOut.has(i.user.id)) return;
    const base = describeInteraction(i, this.#ctx.options, this.#ctx.shardCount());
    if (!base) return;
    if (base.command && base.kind !== 'autocomplete') this.#sourceCommand.set(i.id, base.command);
    if (i.isMessageComponent()) {
      const origin = i.message?.interactionMetadata?.id;
      const source = origin ? this.#sourceCommand.get(origin) : undefined;
      if (source) base.sourceCommand = source;
    }
    if (this.#pending.size >= MAX_PENDING) {
      this.#ctx.count('pending_overflow');
      return;
    }
    const timer = setTimeout(() => this.#emit(i.id), PENDING_TIMEOUT_MS);
    timer.unref?.();
    this.#pending.set(i.id, { base, userId: i.user.id, timer });
  }

  handlerStarted(i: Interaction): void {
    this.observe(i);
    const p = this.#pending.get(i.id);
    if (p) p.handler = { state: 'running', start: performance.now() };
  }

  /** `ms` may be left out when the handler's start was reported; without either, no handler time is recorded. */
  handlerFinished(i: Interaction, given: number | undefined, error?: HandlerError): void {
    const p = this.#pending.get(i.id);
    const ms = given ?? (p?.handler?.state === 'running' ? performance.now() - p.handler.start : undefined);
    if (p) {
      p.handler = { state: 'done', ...(ms !== undefined ? { ms } : {}), ...(error ? { error } : {}) };
      if (p.response) this.#emit(i.id);
      return;
    }
    // The row was already sent (timeout while the handler was still running): report late failures separately.
    const emitted = this.#emitted.get(i.id);
    if (emitted && error) {
      this.#ctx.client.enqueue(
        compact({
          id: uuidv7(),
          ts: Date.now(),
          type: 'interaction_error' as const,
          interaction: emitted.eventId,
          command: emitted.command,
          errorClass: error.errorClass,
          errorCode: error.errorCode,
          handlerMs: ms === undefined ? undefined : Math.round(ms),
        }),
        3,
      );
    }
  }

  /** Records the first response, seen as a request to `/interactions/:id/:token/callback`. */
  responded(interactionId: string, info: ResponseInfo): void {
    const p = this.#pending.get(interactionId);
    if (!p || p.response) return;
    p.response = info;
    if (p.handler?.state !== 'running') this.#emit(interactionId);
  }

  /** Sends rows that already have a response; drops those still waiting (used on shutdown). */
  flushPending(): void {
    for (const [id, p] of this.#pending) {
      if (p.response) this.#emit(id);
      else {
        clearTimeout(p.timer);
        this.#pending.delete(id);
        this.#ctx.count('shutdown_pending');
      }
    }
  }

  #emit(interactionId: string): void {
    const p = this.#pending.get(interactionId);
    if (!p) return;
    this.#pending.delete(interactionId);
    clearTimeout(p.timer);
    const handler = p.handler?.state === 'done' ? p.handler : undefined;
    const error = handler?.error;
    // Discord's verdict on the first response comes first: a reply that arrived after the deadline is a missed
    // deadline, even though the same "Unknown interaction" then also surfaces as the handler's error.
    const outcome: Outcome =
      p.response?.outcome === 'timeout' ? 'timeout' : error ? 'error' : (p.response?.outcome ?? 'no_response');
    const modal = p.response?.modalCustomId;
    const event = compact({
      ...p.base,
      // A command answered with a modal carries the modal's ID, which links it to the later submission.
      customId: p.base.customId ?? (modal === undefined ? undefined : recordedCustomId(modal, this.#ctx.options)),
      outcome,
      ackMs: p.response?.ackMs,
      responseType: p.response?.responseType,
      deferred: p.response?.deferred,
      ephemeral: p.response?.ephemeral,
      errorCode: error?.errorCode ?? p.response?.errorCode,
      errorClass: error?.errorClass,
      handlerMs: handler?.ms === undefined ? undefined : Math.round(handler.ms),
    });
    this.#emitted.set(interactionId, {
      eventId: p.base.id,
      ...(p.base.command ? { command: p.base.command } : {}),
    });
    this.#ctx.client.enqueueWithUser(p.userId, p.base.ts, 3, (user) => ({ ...event, user }) as InteractionInput);
  }
}
