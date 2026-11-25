import { TOKENS } from '../../core/tokens.js';
import type { BotModule } from '../../framework/module.js';
import { helpCommand } from './commands/help.command.js';
import { pingCommand } from './commands/ping.command.js';
import { registerReadyListener } from './events/ready.listener.js';

export const coreModule: BotModule = {
  name: 'core',
  setup(context) {
    const prefixes = context.container.resolve(TOKENS.PrefixResolver);
    context.commands.add(pingCommand).add(helpCommand(context.commands, prefixes));
    registerReadyListener(context);
  },
};
