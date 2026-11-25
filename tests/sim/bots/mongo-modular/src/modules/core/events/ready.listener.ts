import { ActivityType, Events } from 'discord.js';
import type { ModuleContext } from '../../../framework/module.js';

export function registerReadyListener({ client, commands, config, logger }: ModuleContext): void {
  client.once(Events.ClientReady, async (ready) => {
    logger.info(`Logged in as ${ready.user.tag} on ${ready.ws.shards.size} shard(s), ${ready.guilds.cache.size} guilds`);
    ready.user.setPresence({
      activities: [{ name: `${config.bot.defaultPrefix}help`, type: ActivityType.Listening }],
    });

    if (!config.discord.syncCommands) return;
    const body = commands.toApplicationCommands();
    try {
      if (config.discord.devGuildId) await ready.application.commands.set(body, config.discord.devGuildId);
      else await ready.application.commands.set(body);
      logger.info(`Synced ${body.length} application commands${config.discord.devGuildId ? ' to the dev guild' : ''}`);
    } catch (error) {
      logger.error('Could not sync application commands', { error });
    }
  });

  client.on(Events.ShardReady, (id, unavailable) =>
    logger.info(`Shard ${id} ready${unavailable?.size ? `, ${unavailable.size} guilds unavailable` : ''}`),
  );
  client.on(Events.ShardDisconnect, (event, id) => logger.warn(`Shard ${id} disconnected (${event.code})`));
  client.on(Events.ShardReconnecting, (id) => logger.info(`Shard ${id} reconnecting`));
  client.on(Events.ShardResume, (id, replayed) => logger.info(`Shard ${id} resumed (${replayed} events replayed)`));
}
