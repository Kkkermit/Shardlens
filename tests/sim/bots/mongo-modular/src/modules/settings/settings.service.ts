import type { AppConfig } from '../../core/config.js';
import { token } from '../../core/container.js';
import { ValidationError } from '../../core/errors.js';
import type { EventBus } from '../../core/event-bus.js';
import type { GuildSettingsRepository } from '../../database/repositories/guild-settings.repository.js';
import type { PrefixResolver } from '../../framework/types.js';

export interface GuildSettings {
  guildId: string;
  prefix: string;
}

const MAX_PREFIX_LENGTH = 5;

export class SettingsService implements PrefixResolver {
  private readonly prefixCache = new Map<string, { prefix: string; expiresAt: number }>();

  constructor(
    private readonly repository: GuildSettingsRepository,
    private readonly bus: EventBus,
    private readonly config: AppConfig['bot'],
  ) {}

  async resolve(guildId: string | null): Promise<string> {
    if (!guildId) return this.config.defaultPrefix;
    const cached = this.prefixCache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.prefix;
    const { prefix } = await this.get(guildId);
    this.prefixCache.set(guildId, { prefix, expiresAt: Date.now() + this.config.prefixCacheTtlMs });
    return prefix;
  }

  async get(guildId: string): Promise<GuildSettings> {
    const stored = await this.repository.findByGuildId(guildId);
    return { guildId, prefix: stored?.prefix ?? this.config.defaultPrefix };
  }

  async setPrefix(guildId: string, prefix: string): Promise<void> {
    if (prefix.length > MAX_PREFIX_LENGTH || /\s/.test(prefix)) {
      throw new ValidationError(`A prefix is 1 to ${MAX_PREFIX_LENGTH} characters, without spaces.`);
    }
    await this.repository.setPrefix(guildId, prefix);
    this.bus.emit('settings.prefixChanged', { guildId, prefix });
  }

  invalidate(guildId: string): void {
    this.prefixCache.delete(guildId);
  }

  async ensureDefaults(guildId: string): Promise<void> {
    await this.repository.upsertDefaults(guildId, { prefix: this.config.defaultPrefix });
  }

  async markLeft(guildId: string): Promise<void> {
    this.invalidate(guildId);
    await this.repository.markLeft(guildId);
  }
}

export const SETTINGS = {
  Service: token<SettingsService>('SettingsService'),
} as const;
