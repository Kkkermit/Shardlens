import type { BatchInput, EventInput } from '../src/index.js';

export const USER_HASH = 'h1:2026-11:9f3c1a0b6e2d4f7a8c5b1e3d2a4f6c8e';

export function interaction(overrides: Partial<Extract<EventInput, { type: 'interaction' }>> = {}): EventInput {
  return {
    id: '0193f2b4-7c1a-7d4e-9a51-3c2f1e0b9a77',
    type: 'interaction',
    ts: 1763052121000,
    kind: 'chat_input',
    command: 'ticket',
    sub: 'open',
    options: ['category'],
    context: 0,
    install: 'guild',
    guild: '112233445566778899',
    locale: 'en-GB',
    user: USER_HASH,
    premium: false,
    outcome: 'ok',
    ackMs: 412,
    deferred: false,
    handlerMs: 380,
    ...overrides,
  };
}

export function messageCommand(overrides: Partial<Extract<EventInput, { type: 'message_command' }>> = {}): EventInput {
  return {
    id: '0193f2b4-7c1a-7d4e-9a51-3c2f1e0b9a79',
    type: 'message_command',
    ts: 1763052121000,
    command: 'ban',
    options: ['user', 'reason'],
    guild: '112233445566778899',
    channelType: 0,
    memberTier: 'manager',
    user: USER_HASH,
    outcome: 'ok',
    handlerMs: 120,
    ...overrides,
  };
}

export function guildInfo(overrides: Record<string, unknown> = {}) {
  return {
    guild: '112233445566778899',
    name: 'Test server',
    icon: null,
    memberCount: 42,
    large: false,
    preferredLocale: 'en-GB',
    features: ['COMMUNITY'],
    premiumTier: 0,
    boosts: 0,
    verificationLevel: 1,
    nsfwLevel: 0,
    mfaLevel: 0,
    createdAt: 1600000000000,
    joinedAt: 1763052121000,
    shard: 0,
    channelCounts: { '0': 5, '2': 2 },
    roleCount: 4,
    emojiCount: 0,
    stickerCount: 0,
    botPermissions: '2147483648',
    ...overrides,
  };
}

export function batch(events: unknown[], overrides: Partial<BatchInput> = {}): Record<string, unknown> {
  return {
    v: 1,
    mode: 'privacy',
    sdk: { name: '@shardlens/discordjs', version: '1.0.0' },
    app: { id: '1234567890123456789', env: 'production', release: '2.4.1' },
    source: { shards: [3], cluster: 1, instance: 'vps-a:4121' },
    sentAt: '2026-11-13T16:42:01.234Z',
    events,
    ...overrides,
  };
}
