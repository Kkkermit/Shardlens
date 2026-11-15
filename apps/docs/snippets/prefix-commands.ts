import type { Shardlens } from '@shardlens/discordjs';
import { type Client, Events, type Message } from 'discord.js';

declare const client: Client;
declare const lens: Shardlens;

interface PrefixCommand {
  name: string;
  execute(message: Message, args: string[]): Promise<void>;
}
declare const commands: Map<string, PrefixCommand>;
declare const aliases: Map<string, string>;

const PREFIX = '!';

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;
  const [typed = '', ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = commands.get(aliases.get(typed.toLowerCase()) ?? typed.toLowerCase());
  // Only commands your bot knows are recorded, so random text after the prefix never reaches Shardlens.
  if (!command) return;

  // Pass the command's own name, never `typed`. Shardlens doesn't read the message's content.
  const run = lens.wrapMessageCommand(command.name, (m: Message) => command.execute(m, args));
  await run(message);
});
