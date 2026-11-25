import type { EventBus } from '../../../core/event-bus.js';
import type { Logger } from '../../../core/logger.js';
import type { SettingsService } from '../settings.service.js';

export function registerGuildLifecycle(bus: EventBus, settings: SettingsService, logger: Logger): void {
  bus.on('guild.joined', async ({ guildId, name, memberCount }) => {
    logger.info(`Joined "${name}" (${guildId}, ${memberCount} members)`);
    await settings.ensureDefaults(guildId);
  });

  bus.on('guild.left', async ({ guildId }) => {
    logger.info(`Left guild ${guildId}`);
    await settings.markLeft(guildId);
  });

  bus.on('settings.prefixChanged', ({ guildId, prefix }) => {
    settings.invalidate(guildId);
    logger.info(`Prefix in guild ${guildId} is now "${prefix}"`);
  });
}
