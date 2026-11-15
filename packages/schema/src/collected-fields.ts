/**
 * The "Data collected" register: every field the SDK can send, why, in which mode, and for how long it is kept.
 *
 * The docs site renders its Data collected page from this list, and a unit test fails when a wire-format field is
 * missing from it. Changing a collected field means changing this file in the same pull request.
 */

/** `privacy`: sent in both modes. `audit`: sent only when the SDK and collector both run in audit mode. */
export type FieldMode = 'privacy' | 'audit';

/**
 * `no`: not personal data. `pseudonymous`: a keyed hash that becomes unlinkable when its salt is destroyed.
 * `yes`: identifies a person (audit-mode actor fields, or the app's own team for dashboard login).
 */
export type Personal = 'no' | 'pseudonymous' | 'yes';

/** How long the collector keeps each kind of field, worded as the docs show it. */
export const RETENTION = {
  transient: 'Not stored; used while processing the batch only',
  raw: 'Raw rows 35 days (configurable 7–90), then aggregate counts only',
  audit: 'Encrypted; 30 days by default, 90 days maximum',
  hash: 'In unique-user counts until the salt for its period is destroyed (period end + 7 days); raw rows expire after 35 days (configurable 7–90)',
  guild: 'While the bot is installed, plus 90 days after it leaves',
  registry: 'While the command stays registered',
  gauge: '30 days as sent (every 30 seconds for process gauges), then deleted',
  latest: 'Latest value only',
  history: 'No automatic expiry. A user hash in it can no longer be linked to anyone once its salt is destroyed',
} as const;

export type RetentionKey = keyof typeof RETENTION;

/** Object a field belongs to: the batch envelope, a wire event type, or a nested object. */
export type CollectedObject =
  | 'envelope'
  | 'event'
  | 'actor'
  | 'guild_info'
  | 'interaction'
  | 'guild_join'
  | 'guild_update'
  | 'guild_leave'
  | 'guild_availability'
  | 'guild_snapshot'
  | 'command_registry'
  | 'shard_state'
  | 'rest_window'
  | 'rate_limit'
  | 'invalid_request_warning'
  | 'gauge_window'
  | 'entitlement'
  | 'subscription'
  | 'custom'
  | 'app_info'
  | 'sdk_health'
  | 'interaction_error'
  | 'message_command'
  | 'command_permissions';

/** One field the SDK can send. */
export interface CollectedField {
  readonly object: CollectedObject;
  readonly field: string;
  readonly description: string;
  readonly mode: FieldMode;
  readonly personal: Personal;
  readonly retention: RetentionKey;
}

type Opts = Partial<Pick<CollectedField, 'mode' | 'personal' | 'retention'>>;

function f(object: CollectedObject, field: string, description: string, opts: Opts = {}): CollectedField {
  return {
    object,
    field,
    description,
    mode: opts.mode ?? 'privacy',
    personal: opts.personal ?? 'no',
    retention: opts.retention ?? 'raw',
  };
}

/** Every field the wire format can carry, in the order the docs list them. */
export const COLLECTED_FIELDS: readonly CollectedField[] = [
  f('envelope', 'v', 'Wire-format major version.', { retention: 'transient' }),
  f('envelope', 'mode', 'Data mode the SDK runs in (privacy or audit).', { retention: 'transient' }),
  f('envelope', 'sdk', 'SDK package name and version, kept with the SDK health of the sending process.', {
    retention: 'latest',
  }),
  f('envelope', 'app', 'Discord application ID, environment name and bot release.'),
  f(
    'envelope',
    'source',
    'Shard IDs and an instance label (host name and process ID) for the sending process, kept with its SDK health and its gauges. The cluster ID (discord-hybrid-sharding) is sent but not stored.',
    { retention: 'gauge' },
  ),
  f('envelope', 'sentAt', 'When the batch was sent; used to correct clock skew.', { retention: 'transient' }),
  f('envelope', 'events', 'The events in the batch.', { retention: 'transient' }),

  f('event', 'id', 'UUIDv7 event ID; makes retries idempotent.'),
  f('event', 'ts', 'When the event happened (epoch milliseconds).'),
  f('event', 'weight', 'Inverse sample rate, so sampled counts stay accurate.'),
  f('event', 'type', 'Event type.'),

  f('interaction', 'kind', 'Slash command, context menu, entry point, button, select, modal submit or autocomplete.'),
  f('interaction', 'command', 'Command name.'),
  f('interaction', 'group', 'Subcommand group name.'),
  f('interaction', 'sub', 'Subcommand name.'),
  f('interaction', 'commandId', 'Registered command ID.'),
  f('interaction', 'commandScope', 'Whether the command is global or registered to one server.'),
  f('interaction', 'options', 'Names of the options used. Values are not collected.'),
  f(
    'interaction',
    'optionValues',
    'Values of options the bot owner allow-listed with `captureOptionValues` only. Never user, channel, role, mentionable or attachment options, nor a value holding a Discord ID.',
  ),
  f(
    'interaction',
    'customId',
    "Component or modal custom ID (for a command that opened a modal, the modal's), with secrets removed and numbers and IDs replaced by `*`, or as the bot's `normaliseCustomId` rewrites it.",
  ),
  f('interaction', 'componentType', 'Component type number.'),
  f('interaction', 'sourceCommand', 'Command that created the message a component is on.'),
  f('interaction', 'context', 'Where it ran: server, bot DM or private channel.'),
  f('interaction', 'install', 'Whether the app was server-installed, user-installed or both.'),
  f('interaction', 'guild', 'Server ID (not personal data).'),
  f('interaction', 'channelType', 'Channel type number. Channel IDs and names are never collected.'),
  f('interaction', 'locale', "The user's Discord app language (not their location)."),
  f('interaction', 'guildLocale', "The server's preferred language."),
  f('interaction', 'memberTier', 'Admin, manager, member or DM, derived from the member’s permissions.'),
  f('interaction', 'user', 'Keyed hash of the user ID, computed inside the bot process.', {
    personal: 'pseudonymous',
    retention: 'hash',
  }),
  f('interaction', 'actor', 'Who ran it (raw user ID, optional names). Audit mode only; encrypted at rest.', {
    mode: 'audit',
    personal: 'yes',
    retention: 'audit',
  }),
  f('interaction', 'premium', 'Whether the user or server has an active entitlement.'),
  f('interaction', 'outcome', 'ok, error, timeout (missed 3-second deadline) or no response.'),
  f('interaction', 'errorCode', 'Discord API error code, if the response failed.'),
  f('interaction', 'errorClass', 'Error class name the handler threw. Never messages or stack traces.'),
  f('interaction', 'ackMs', 'Milliseconds from Discord creating the interaction to the first response.'),
  f('interaction', 'responseType', 'Interaction callback type (for example deferred or modal).'),
  f('interaction', 'deferred', 'Whether the first response was a deferral.'),
  f('interaction', 'ephemeral', 'Whether the first response was ephemeral.'),
  f('interaction', 'handlerMs', 'Handler duration, when the handler is wrapped or reports when it finished.'),
  f('interaction', 'shard', 'Shard that received the interaction.'),

  f('message_command', 'command', 'Command name as the bot defines it, after aliases. Never the text the user typed.'),
  f('message_command', 'group', 'Subcommand group name, if the bot reports one.'),
  f('message_command', 'sub', 'Subcommand name, if the bot reports one.'),
  f('message_command', 'options', 'Names of the arguments the bot reports as used. Values are not collected.'),
  f(
    'message_command',
    'optionValues',
    'Values of arguments the bot owner allow-listed with `captureOptionValues` only. Never a value holding a Discord ID.',
  ),
  f('message_command', 'guild', 'Server ID (not personal data).'),
  f('message_command', 'channelType', 'Channel type number. Channel IDs and names are never collected.'),
  f('message_command', 'guildLocale', "The server's preferred language."),
  f('message_command', 'memberTier', 'Admin, manager, member or DM, derived from the member’s permissions.'),
  f('message_command', 'user', 'Keyed hash of the message author’s ID, computed inside the bot process.', {
    personal: 'pseudonymous',
    retention: 'hash',
  }),
  f('message_command', 'actor', 'Who ran it (raw user ID, optional names). Audit mode only; encrypted at rest.', {
    mode: 'audit',
    personal: 'yes',
    retention: 'audit',
  }),
  f('message_command', 'outcome', 'ok or error, as the handler finished.'),
  f('message_command', 'errorClass', 'Error class name the handler threw. Never messages or stack traces.'),
  f('message_command', 'errorCode', 'Discord API error code, if the error came from Discord.'),
  f('message_command', 'handlerMs', 'Handler duration, when the bot reports it.'),
  f('message_command', 'shard', 'Shard that received the message.'),

  f('interaction_error', 'interaction', 'ID of the interaction event the error belongs to.'),
  f('interaction_error', 'command', 'Command name.'),
  f('interaction_error', 'errorClass', 'Error class name the handler threw. Never messages or stack traces.'),
  f('interaction_error', 'errorCode', 'Discord API error code, if the error came from Discord.'),
  f('interaction_error', 'handlerMs', 'Handler duration until it failed.'),

  f('command_permissions', 'guild', 'Server that changed command permissions.', { retention: 'history' }),
  f('command_permissions', 'command', 'Command ID, or the application ID for app-wide changes.', {
    retention: 'history',
  }),
  f(
    'command_permissions',
    'overwrites',
    'Number of permission overwrites now set. Role and user IDs are not collected.',
    { retention: 'history' },
  ),

  f('actor', 'userId', 'Discord user ID of the person who ran the interaction or message command.', {
    mode: 'audit',
    personal: 'yes',
    retention: 'audit',
  }),
  f('actor', 'username', 'Username. Left out with `auditIncludeProfile: false`.', {
    mode: 'audit',
    personal: 'yes',
    retention: 'audit',
  }),
  f('actor', 'avatar', 'Avatar hash, to show the profile picture. Left out with `auditIncludeProfile: false`.', {
    mode: 'audit',
    personal: 'yes',
    retention: 'audit',
  }),

  f('guild_info', 'guild', 'Server ID.', { retention: 'guild' }),
  f('guild_info', 'name', 'Server name (rendered as plain text).', { retention: 'guild' }),
  f('guild_info', 'icon', 'Server icon hash.', { retention: 'guild' }),
  f(
    'guild_info',
    'memberCount',
    "Member count when the profile was sent (on joining, after a restart and on server updates), or Discord's approximate count with `refreshGuildCounts`.",
    { retention: 'guild' },
  ),
  f('guild_info', 'large', "Discord's large-server flag.", { retention: 'guild' }),
  f('guild_info', 'preferredLocale', "The server's preferred language.", { retention: 'guild' }),
  f('guild_info', 'features', 'Server feature flags such as COMMUNITY or PARTNERED.', { retention: 'guild' }),
  f('guild_info', 'premiumTier', 'Boost tier.', { retention: 'guild' }),
  f('guild_info', 'boosts', 'Number of boosts.', { retention: 'guild' }),
  f('guild_info', 'verificationLevel', 'Verification level.', { retention: 'guild' }),
  f('guild_info', 'nsfwLevel', 'NSFW level.', { retention: 'guild' }),
  f('guild_info', 'mfaLevel', 'Moderator MFA requirement.', { retention: 'guild' }),
  f('guild_info', 'createdAt', 'When the server was created.', { retention: 'guild' }),
  f('guild_info', 'joinedAt', 'When the bot joined.', { retention: 'guild' }),
  f('guild_info', 'shard', 'Shard the server is on.', { retention: 'guild' }),
  f('guild_info', 'channelCounts', 'Number of channels of each type. Never names.', { retention: 'guild' }),
  f('guild_info', 'roleCount', 'Number of roles.', { retention: 'guild' }),
  f('guild_info', 'emojiCount', 'Number of custom emojis.', { retention: 'guild' }),
  f('guild_info', 'stickerCount', 'Number of stickers.', { retention: 'guild' }),
  f('guild_info', 'botPermissions', "The bot's permission bitfield in the server.", { retention: 'guild' }),

  f('guild_join', 'info', 'Server profile at install.', { retention: 'guild' }),
  f('guild_join', 'detectedAtStartup', 'True when the join happened while the bot was offline.', {
    retention: 'history',
  }),
  f('guild_update', 'info', 'Updated server profile.', { retention: 'guild' }),
  f('guild_leave', 'guild', 'Server ID that removed the bot.', { retention: 'history' }),
  f('guild_leave', 'detectedAtStartup', 'True when the removal happened while the bot was offline.', {
    retention: 'history',
  }),
  f('guild_availability', 'guild', 'Server ID affected by a Discord outage.', { retention: 'history' }),
  f('guild_availability', 'available', 'Whether the server became available or unavailable.', {
    retention: 'history',
  }),
  f('guild_availability', 'shard', 'Shard the server is on. Not stored.', { retention: 'transient' }),
  f('guild_snapshot', 'shards', 'Shards reporting the snapshot.', { retention: 'transient' }),
  f('guild_snapshot', 'shardCount', 'Total shard count, to detect resharding.', { retention: 'transient' }),
  f(
    'guild_snapshot',
    'guilds',
    'Server IDs on those shards, diffed to find joins and removals while offline. Held for up to a day while a new shard layout is still reporting.',
    { retention: 'transient' },
  ),

  f('command_registry', 'commands', 'Registered commands (ID, name, type, scope, subcommands) to find unused ones.', {
    retention: 'registry',
  }),

  f('shard_state', 'shard', 'Shard ID.', { retention: 'history' }),
  f(
    'shard_state',
    'state',
    'Ready, resumed, reconnecting, disconnected, error or invalidated. discord.js 15 reports ready, resumed and disconnected.',
    { retention: 'history' },
  ),
  f('shard_state', 'closeCode', 'Gateway close code.', { retention: 'history' }),
  f('shard_state', 'replayed', 'Events replayed on resume.', { retention: 'history' }),
  f(
    'shard_state',
    'unavailableGuilds',
    'Servers still unavailable when the shard became ready (discord.js 14). Not stored.',
    { retention: 'transient' },
  ),
  f('rest_window', 'windowMs', 'Length of the aggregation window. Not stored.', { retention: 'transient' }),
  f(
    'rest_window',
    'rows',
    'REST call counts, retries and latency histograms by method, route and status. Routes hold route words only: IDs, invite and template codes, tokens, query strings and any other value are replaced.',
  ),
  f('rest_window', 'invalid', '401, 403 and 429 counts toward the invalid-request ban threshold.'),
  f('rate_limit', 'scope', 'Scope of the rate limit a request was held back for: user, global or shared.'),
  f('rate_limit', 'global', 'Whether the limit was global.'),
  f(
    'rate_limit',
    'route',
    'Route with route words only, as for REST calls (never the raw path, which can contain tokens).',
  ),
  f('rate_limit', 'method', 'HTTP method.'),
  f('rate_limit', 'limit', 'Request limit for the bucket. Not stored.', { retention: 'transient' }),
  f('rate_limit', 'retryAfter', 'Milliseconds until the request may be retried.'),
  f('rate_limit', 'sublimitTimeout', 'Sub-limit timeout, if any. Not stored.', { retention: 'transient' }),
  f(
    'invalid_request_warning',
    'count',
    'Invalid requests counted by discord.js in the current window, kept as the `rest.invalid_warning_count` gauge.',
    { retention: 'gauge' },
  ),
  f('invalid_request_warning', 'remainingTime', 'Milliseconds left in the window. Not stored.', {
    retention: 'transient',
  }),
  f('gauge_window', 'gauges', 'Process and gateway gauges: shard ping and servers, event-loop delay, memory, caches.', {
    retention: 'gauge',
  }),

  // Entitlements and subscriptions are kept as history: active ones are counted from all changes, however old.
  f('entitlement', 'action', 'Created, updated or deleted.', { retention: 'history' }),
  f('entitlement', 'sku', 'SKU ID.', { retention: 'history' }),
  f('entitlement', 'entitlementType', 'Entitlement type (purchase, test, subscription and so on).', {
    retention: 'history',
  }),
  f('entitlement', 'owner', 'Whether a user or a server owns the entitlement.', { retention: 'history' }),
  f('entitlement', 'user', 'Keyed hash of the owning user.', { personal: 'pseudonymous', retention: 'history' }),
  f('entitlement', 'guild', 'Owning server ID.', { retention: 'history' }),
  f('entitlement', 'startsAt', 'Start time.', { retention: 'history' }),
  f('entitlement', 'endsAt', 'End time.', { retention: 'history' }),
  f('subscription', 'action', 'Created, updated or deleted.', { retention: 'history' }),
  f('subscription', 'status', 'Subscription status.', { retention: 'history' }),
  f('subscription', 'skus', 'SKU IDs.', { retention: 'history' }),
  f('subscription', 'user', 'Keyed hash of the subscriber.', { personal: 'pseudonymous', retention: 'history' }),
  f('subscription', 'periodStart', 'Current period start.', { retention: 'history' }),
  f('subscription', 'periodEnd', 'Current period end.', { retention: 'history' }),

  f('custom', 'name', 'Custom event name passed to `track()`.'),
  f('custom', 'props', 'Properties passed to `track()`, chosen by the bot owner. The SDK sends at most 2 KB.'),
  f('custom', 'user', 'Keyed hash of the user, if the bot passes one.', {
    personal: 'pseudonymous',
    retention: 'hash',
  }),
  f('custom', 'guild', 'Server ID, if the bot passes one.'),

  f('app_info', 'name', 'Application name.', { retention: 'latest' }),
  f('app_info', 'approximateGuildCount', "Discord's approximate server count.", { retention: 'gauge' }),
  f('app_info', 'approximateUserInstallCount', "Discord's approximate user-install count.", { retention: 'gauge' }),
  f('app_info', 'approximateUserAuthorizationCount', "Discord's approximate user-authorisation count.", {
    retention: 'latest',
  }),
  f(
    'app_info',
    'dashboardUserIds',
    "The app owner's or accepted team members' user IDs, kept as they are to check a Discord sign-in to the dashboard. Admin sessions and the admin activity log keep the ID of the team member who signed in.",
    {
      personal: 'yes',
      retention: 'latest',
    },
  ),
  f('app_info', 'eventWebhooksStatus', 'Whether Discord webhook events are enabled.', { retention: 'latest' }),
  f('app_info', 'skus', 'SKU IDs, names and types.', { retention: 'latest' }),
  f('app_info', 'sessionStartRemaining', 'Identify calls left in the current 24-hour window.', { retention: 'gauge' }),
  f('app_info', 'sessionStartTotal', 'Identify calls allowed per 24 hours.', { retention: 'latest' }),
  f('app_info', 'nodeVersion', 'Node.js version of the bot process.', { retention: 'latest' }),
  f('app_info', 'libVersion', 'discord.js version of the bot process.', { retention: 'latest' }),

  f('sdk_health', 'queueDepth', 'Events waiting to be sent.', { retention: 'latest' }),
  f('sdk_health', 'dropped', 'Events dropped, by priority lane and by reason.', { retention: 'latest' }),
  f('sdk_health', 'failedFlushes', 'Batches that failed to send.', { retention: 'latest' }),
  f('sdk_health', 'internalErrors', 'Errors caught inside the SDK, by name.', { retention: 'latest' }),
];
