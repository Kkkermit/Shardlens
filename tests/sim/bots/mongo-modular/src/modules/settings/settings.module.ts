import { TOKENS } from '../../core/tokens.js';
import { REPOSITORIES } from '../../database/index.js';
import type { BotModule } from '../../framework/module.js';
import { prefixCommand } from './commands/prefix.command.js';
import { settingsCommand } from './commands/settings.command.js';
import { registerGuildLifecycle } from './events/guild-lifecycle.listener.js';
import { SETTINGS, SettingsService } from './settings.service.js';

export const settingsModule: BotModule = {
  name: 'settings',
  register(container) {
    container.register(
      SETTINGS.Service,
      (c) => new SettingsService(c.resolve(REPOSITORIES.GuildSettings), c.resolve(TOKENS.EventBus), c.resolve(TOKENS.Config).bot),
    );
    // the framework asks for prefixes through this, so it doesn't depend on this module
    container.register(TOKENS.PrefixResolver, (c) => c.resolve(SETTINGS.Service));
  },
  setup({ container, commands, bus, logger }) {
    const settings = container.resolve(SETTINGS.Service);
    commands.add(prefixCommand(settings)).add(settingsCommand(settings));
    registerGuildLifecycle(bus, settings, logger);
  },
};
