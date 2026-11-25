require('dotenv').config();
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const { createShardlens } = require('@shardlens/discordjs');
const mongoose = require('mongoose');

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
client.slashCommands = new Collection();
// warnings waiting for the mod to press Confirm, by moderator id
client.pendingWarns = new Collection();
// analytics, stored in the bot's own MongoDB (collections prefixed shardlens_)
client.lens = createShardlens(client, { mongodb: process.env.MONGO_URI, release: process.env.npm_package_version });

require('./handlers/commandHandler')(client);
require('./handlers/eventHandler')(client);

mongoose.set('strictQuery', true);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('[DB] Connected to MongoDB');
    client.login(process.env.DISCORD_TOKEN);
  })
  .catch((err) => {
    console.error('[DB] Could not connect to MongoDB', err);
    process.exit(1);
  });

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  await client.lens.shutdown();
  try {
    await client.destroy();
    await mongoose.connection.close();
    console.log('[DB] Connection closed');
  } catch (err) {
    console.error('Error while shutting down', err);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
