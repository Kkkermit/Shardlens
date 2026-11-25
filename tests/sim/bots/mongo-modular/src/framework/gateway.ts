import { Events } from 'discord.js';
import type { Container } from '../core/container.js';
import { TOKENS } from '../core/tokens.js';
import { parsePrefixed } from './prefix-parser.js';

/** Connects Discord's events to the command registry, the component router and the event bus. */
export function bindGateway(container: Container): void {
  const client = container.resolve(TOKENS.Client);
  const commands = container.resolve(TOKENS.Commands);
  const components = container.resolve(TOKENS.Components);
  const prefixes = container.resolve(TOKENS.PrefixResolver);
  const bus = container.resolve(TOKENS.EventBus);
  const logger = container.resolve(TOKENS.Logger).child('gateway');

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) await commands.handleChatInput(interaction);
    else if (interaction.isAutocomplete()) await commands.handleAutocomplete(interaction);
    else if (interaction.isContextMenuCommand()) await commands.handleContextMenu(interaction);
    else if (interaction.isMessageComponent() || interaction.isModalSubmit()) await components.handle(interaction);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || message.webhookId) return;
    try {
      const prefix = await prefixes.resolve(message.guildId);
      const mention = client.user ? [`<@${client.user.id}>`, `<@!${client.user.id}>`] : [];
      const parsed = parsePrefixed(message.content, [prefix, ...mention]);
      if (parsed) await commands.handleMessage(message, parsed.name, parsed.args);
    } catch (error) {
      logger.error('Could not handle a message', { guildId: message.guildId, error });
    }
  });

  client.on(Events.GuildCreate, (guild) =>
    bus.emit('guild.joined', { guildId: guild.id, name: guild.name, memberCount: guild.memberCount }),
  );
  client.on(Events.GuildDelete, (guild) => bus.emit('guild.left', { guildId: guild.id }));

  client.on(Events.Error, (error) => logger.error('Discord client error', { error }));
  client.on(Events.Warn, (warning) => logger.warn(warning));
}
