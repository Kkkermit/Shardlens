import { Events, Listener } from '@sapphire/framework';
import type { Client } from 'discord.js';

export class ReadyListener extends Listener<typeof Events.ClientReady> {
  public constructor(context: Listener.LoaderContext, options: Listener.Options) {
    super(context, { ...options, once: true, event: Events.ClientReady });
  }

  public run(client: Client<true>) {
    this.container.logger.info(`Ready as ${client.user.tag}`);
  }
}
