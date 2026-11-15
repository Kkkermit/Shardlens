require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags, Partials } = require('discord.js');
const { startEmbeddedCollector } = require('@shardlens/collector/embedded');
const { createShardlens } = require('@shardlens/discordjs');
const { version } = require('./package.json');
const prefixes = require('./prefixes');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.commands = new Collection();
client.aliases = new Collection();
for (const file of fs.readdirSync(path.join(__dirname, 'commands')).filter((f) => f.endsWith('.js'))) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.name, command);
  for (const alias of command.aliases ?? []) client.aliases.set(alias, command.name);
}

client.slash = new Collection();
for (const file of fs.readdirSync(path.join(__dirname, 'slash')).filter((f) => f.endsWith('.js'))) {
  const command = require(`./slash/${file}`);
  client.slash.set(command.data.name, command);
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const prefix = prefixes.get(message.guildId);
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const typed = args.shift()?.toLowerCase();
  if (!typed) return;
  const command = client.commands.get(typed) ?? client.commands.get(client.aliases.get(typed));
  if (!command) return;

  const started = performance.now();
  let failed = false;
  try {
    await command.execute(message, args);
  } catch (error) {
    failed = true;
    console.error(`Command ${command.name} failed:`, error.message);
    await message.reply('Something went wrong running that command.').catch(() => {});
  }
  client.lens.trackMessageCommand(message, { command: command.name, durationMs: performance.now() - started, failed });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('confirm:')) {
      await interaction.update({ content: 'Confirmed.', components: [] });
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = client.slash.get(interaction.commandName);
  if (!command) return;
  try {
    await client.lens.wrap((i) => command.execute(i))(interaction);
  } catch (error) {
    console.error(`Slash command ${interaction.commandName} failed:`, error.message);
    const reply = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

async function start() {
  // Unlike the SDK, the embedded collector can fail to start: a port in use, a folder it can't write to, a missing
  // application ID. Catch that, so the bot starts without analytics instead of not starting.
  const collector = await startEmbeddedCollector({
    dataDir: './data/shardlens',
    appId: process.env.DISCORD_APP_ID ?? '',
    port: 8091,
    sink: { to: 'sqlite:./data/shardlens-events.db' },
  }).catch((error) => {
    console.error('Shardlens: the embedded collector did not start.', error);
    return undefined;
  });
  client.lens = createShardlens(client, { endpoint: collector?.url, apiKey: collector?.ingestKey, release: version });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await client.lens.shutdown();
      await collector?.close();
      await client.destroy();
      process.exit(0);
    });
  }

  client.login(process.env.DISCORD_TOKEN);
}

start();
