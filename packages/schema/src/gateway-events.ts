/**
 * How Shardlens treats every Gateway dispatch event, verified against Discord's Gateway docs (ADR 0006). A unit test
 * compares this list with `GatewayDispatchEvents` from discord-api-types, so a new Gateway event fails CI until someone
 * decides how to treat it.
 */

/**
 * `used`: collected in v1. `indirect`: not collected, but keeps cache-based counts current.
 * `plugin`: optional plugin only (needs extra intents). `not_used`: delivered with Guilds but ignored.
 * `never`: never collected, by policy. `ignored`: little or no public documentation.
 */
export type GatewayEventUse = 'used' | 'indirect' | 'plugin' | 'not_used' | 'never' | 'ignored';

export interface GatewayEventCoverage {
  readonly event: string;
  /** Gateway intent that delivers the event, or `null` when no intent is needed. */
  readonly intent: string | null;
  readonly privileged: boolean;
  readonly use: GatewayEventUse;
}

type Row = readonly [event: string, intent: string | null, use: GatewayEventUse];

const PRIVILEGED = new Set(['GUILD_MEMBERS', 'GUILD_PRESENCES', 'MESSAGE_CONTENT']);

const ROWS: readonly Row[] = [
  // Always delivered, no intent
  ['READY', null, 'used'],
  ['RESUMED', null, 'used'],
  ['INTERACTION_CREATE', null, 'used'],
  ['APPLICATION_COMMAND_PERMISSIONS_UPDATE', null, 'used'],
  ['ENTITLEMENT_CREATE', null, 'used'],
  ['ENTITLEMENT_UPDATE', null, 'used'],
  ['ENTITLEMENT_DELETE', null, 'used'],
  ['SUBSCRIPTION_CREATE', null, 'used'],
  ['SUBSCRIPTION_UPDATE', null, 'used'],
  ['SUBSCRIPTION_DELETE', null, 'used'],
  ['USER_UPDATE', null, 'not_used'],
  ['VOICE_SERVER_UPDATE', null, 'not_used'],
  ['RATE_LIMITED', null, 'not_used'],
  ['GUILD_MEMBERS_CHUNK', null, 'never'],
  ['CHANNEL_INFO', null, 'ignored'],
  ['SOUNDBOARD_SOUNDS', null, 'not_used'],

  // GUILDS (1 << 0)
  ['GUILD_CREATE', 'GUILDS', 'used'],
  ['GUILD_UPDATE', 'GUILDS', 'used'],
  ['GUILD_DELETE', 'GUILDS', 'used'],
  ['GUILD_ROLE_CREATE', 'GUILDS', 'indirect'],
  ['GUILD_ROLE_UPDATE', 'GUILDS', 'indirect'],
  ['GUILD_ROLE_DELETE', 'GUILDS', 'indirect'],
  ['CHANNEL_CREATE', 'GUILDS', 'indirect'],
  ['CHANNEL_UPDATE', 'GUILDS', 'indirect'],
  ['CHANNEL_DELETE', 'GUILDS', 'indirect'],
  ['CHANNEL_PINS_UPDATE', 'GUILDS', 'not_used'],
  ['THREAD_CREATE', 'GUILDS', 'not_used'],
  ['THREAD_UPDATE', 'GUILDS', 'not_used'],
  ['THREAD_DELETE', 'GUILDS', 'not_used'],
  ['THREAD_LIST_SYNC', 'GUILDS', 'not_used'],
  ['THREAD_MEMBER_UPDATE', 'GUILDS', 'not_used'],
  ['THREAD_MEMBERS_UPDATE', 'GUILDS', 'not_used'],
  ['STAGE_INSTANCE_CREATE', 'GUILDS', 'not_used'],
  ['STAGE_INSTANCE_UPDATE', 'GUILDS', 'not_used'],
  ['STAGE_INSTANCE_DELETE', 'GUILDS', 'not_used'],
  ['VOICE_CHANNEL_STATUS_UPDATE', 'GUILDS', 'not_used'],
  ['VOICE_CHANNEL_START_TIME_UPDATE', 'GUILDS', 'not_used'],

  // GUILD_MEMBERS (1 << 1, privileged)
  ['GUILD_MEMBER_ADD', 'GUILD_MEMBERS', 'plugin'],
  ['GUILD_MEMBER_UPDATE', 'GUILD_MEMBERS', 'plugin'],
  ['GUILD_MEMBER_REMOVE', 'GUILD_MEMBERS', 'plugin'],

  // GUILD_MODERATION (1 << 2)
  ['GUILD_AUDIT_LOG_ENTRY_CREATE', 'GUILD_MODERATION', 'never'],
  ['GUILD_BAN_ADD', 'GUILD_MODERATION', 'never'],
  ['GUILD_BAN_REMOVE', 'GUILD_MODERATION', 'never'],

  // GUILD_EXPRESSIONS (1 << 3)
  ['GUILD_EMOJIS_UPDATE', 'GUILD_EXPRESSIONS', 'not_used'],
  ['GUILD_STICKERS_UPDATE', 'GUILD_EXPRESSIONS', 'not_used'],
  ['GUILD_SOUNDBOARD_SOUND_CREATE', 'GUILD_EXPRESSIONS', 'not_used'],
  ['GUILD_SOUNDBOARD_SOUND_UPDATE', 'GUILD_EXPRESSIONS', 'not_used'],
  ['GUILD_SOUNDBOARD_SOUND_DELETE', 'GUILD_EXPRESSIONS', 'not_used'],
  ['GUILD_SOUNDBOARD_SOUNDS_UPDATE', 'GUILD_EXPRESSIONS', 'not_used'],

  // GUILD_INTEGRATIONS (1 << 4)
  ['GUILD_INTEGRATIONS_UPDATE', 'GUILD_INTEGRATIONS', 'not_used'],
  ['INTEGRATION_CREATE', 'GUILD_INTEGRATIONS', 'not_used'],
  ['INTEGRATION_UPDATE', 'GUILD_INTEGRATIONS', 'not_used'],
  ['INTEGRATION_DELETE', 'GUILD_INTEGRATIONS', 'not_used'],

  // GUILD_WEBHOOKS (1 << 5), GUILD_INVITES (1 << 6)
  ['WEBHOOKS_UPDATE', 'GUILD_WEBHOOKS', 'not_used'],
  ['INVITE_CREATE', 'GUILD_INVITES', 'not_used'],
  ['INVITE_DELETE', 'GUILD_INVITES', 'not_used'],

  // GUILD_VOICE_STATES (1 << 7)
  ['VOICE_STATE_UPDATE', 'GUILD_VOICE_STATES', 'plugin'],
  ['VOICE_CHANNEL_EFFECT_SEND', 'GUILD_VOICE_STATES', 'not_used'],

  // GUILD_PRESENCES (1 << 8, privileged)
  ['PRESENCE_UPDATE', 'GUILD_PRESENCES', 'never'],

  // GUILD_MESSAGES (1 << 9) / DIRECT_MESSAGES (1 << 12); content needs MESSAGE_CONTENT (privileged)
  ['MESSAGE_CREATE', 'GUILD_MESSAGES', 'plugin'],
  ['MESSAGE_UPDATE', 'GUILD_MESSAGES', 'not_used'],
  ['MESSAGE_DELETE', 'GUILD_MESSAGES', 'not_used'],
  ['MESSAGE_DELETE_BULK', 'GUILD_MESSAGES', 'not_used'],

  // GUILD_MESSAGE_REACTIONS (1 << 10) / DIRECT_MESSAGE_REACTIONS (1 << 13)
  ['MESSAGE_REACTION_ADD', 'GUILD_MESSAGE_REACTIONS', 'not_used'],
  ['MESSAGE_REACTION_REMOVE', 'GUILD_MESSAGE_REACTIONS', 'not_used'],
  ['MESSAGE_REACTION_REMOVE_ALL', 'GUILD_MESSAGE_REACTIONS', 'not_used'],
  ['MESSAGE_REACTION_REMOVE_EMOJI', 'GUILD_MESSAGE_REACTIONS', 'not_used'],

  // GUILD_MESSAGE_TYPING (1 << 11) / DIRECT_MESSAGE_TYPING (1 << 14)
  ['TYPING_START', 'GUILD_MESSAGE_TYPING', 'never'],

  // GUILD_SCHEDULED_EVENTS (1 << 16)
  ['GUILD_SCHEDULED_EVENT_CREATE', 'GUILD_SCHEDULED_EVENTS', 'not_used'],
  ['GUILD_SCHEDULED_EVENT_UPDATE', 'GUILD_SCHEDULED_EVENTS', 'not_used'],
  ['GUILD_SCHEDULED_EVENT_DELETE', 'GUILD_SCHEDULED_EVENTS', 'not_used'],
  ['GUILD_SCHEDULED_EVENT_USER_ADD', 'GUILD_SCHEDULED_EVENTS', 'not_used'],
  ['GUILD_SCHEDULED_EVENT_USER_REMOVE', 'GUILD_SCHEDULED_EVENTS', 'not_used'],

  // AUTO_MODERATION_CONFIGURATION (1 << 20) / AUTO_MODERATION_EXECUTION (1 << 21)
  ['AUTO_MODERATION_RULE_CREATE', 'AUTO_MODERATION_CONFIGURATION', 'not_used'],
  ['AUTO_MODERATION_RULE_UPDATE', 'AUTO_MODERATION_CONFIGURATION', 'not_used'],
  ['AUTO_MODERATION_RULE_DELETE', 'AUTO_MODERATION_CONFIGURATION', 'not_used'],
  ['AUTO_MODERATION_ACTION_EXECUTION', 'AUTO_MODERATION_EXECUTION', 'not_used'],

  // GUILD_MESSAGE_POLLS (1 << 24) / DIRECT_MESSAGE_POLLS (1 << 25)
  ['MESSAGE_POLL_VOTE_ADD', 'GUILD_MESSAGE_POLLS', 'not_used'],
  ['MESSAGE_POLL_VOTE_REMOVE', 'GUILD_MESSAGE_POLLS', 'not_used'],
];

export const GATEWAY_EVENT_COVERAGE: readonly GatewayEventCoverage[] = ROWS.map(([event, intent, use]) => ({
  event,
  intent,
  privileged: intent !== null && PRIVILEGED.has(intent),
  use,
}));

/** Intents the v1 SDK needs. Everything else is opt-in. */
export const REQUIRED_INTENTS: readonly string[] = ['GUILDS'];
