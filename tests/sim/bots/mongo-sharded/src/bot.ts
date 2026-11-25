import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { commands } from './commands/index.js';
import { closeDb, connectDb, servers } from './db.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const tag = () => `[shard ${client.shard?.ids.join(',') ?? '?'}]`;

client.once(Events.ClientReady, (c) => {
  console.log(`${tag()} ready as ${c.user.tag} with ${c.guilds.cache.size} servers`);
});

client.on(Events.GuildCreate, async (guild) => {
  console.log(`${tag()} joined ${guild.name}`);
  await servers()
    .updateOne(
      { guildId: guild.id },
      {
        $set: { name: guild.name, memberCount: guild.memberCount, lastSeenAt: new Date() },
        $setOnInsert: { firstSeenAt: new Date() },
        $unset: { leftAt: '' },
      },
      { upsert: true },
    )
    .catch((err) => console.error(`${tag()} could not save server ${guild.id}:`, err));
});
client.on(Events.GuildDelete, async (guild) => {
  console.log(`${tag()} left ${guild.id}`);
  await servers()
    .updateOne({ guildId: guild.id }, { $set: { leftAt: new Date() } })
    .catch((err) => console.error(`${tag()} could not update server ${guild.id}:`, err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) {
    console.warn(`${tag()} unknown command /${interaction.commandName}, did you forget npm run deploy?`);
    return;
  }

  try {
    await command.run(interaction);
  } catch (err) {
    console.error(`${tag()} /${interaction.commandName} failed:`, err);
    const reply = { content: 'Something broke, sorry! Try again in a bit.', flags: MessageFlags.Ephemeral } as const;
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => null);
    else await interaction.reply(reply).catch(() => null);
  }
});

let stopping = false;
async function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  console.log(`${tag()} ${signal}, shutting down`);
  await client.destroy();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await connectDb();
await client.login(process.env.DISCORD_TOKEN);
