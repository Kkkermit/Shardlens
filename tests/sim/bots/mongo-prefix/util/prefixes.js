const GuildConfig = require('../models/GuildConfig');
const { defaultPrefix } = require('../config.json');

// guildId -> prefix, so we don't hit mongo on every single message
const cache = new Map();

async function getPrefix(guildId) {
  if (!guildId) return defaultPrefix; // DMs
  if (cache.has(guildId)) return cache.get(guildId);

  const config = await GuildConfig.findOne({ guildId });
  const prefix = config ? config.prefix : defaultPrefix;
  cache.set(guildId, prefix);
  return prefix;
}

async function setPrefix(guildId, prefix) {
  await GuildConfig.findOneAndUpdate({ guildId }, { prefix }, { upsert: true, new: true });
  cache.set(guildId, prefix);
}

function forget(guildId) {
  cache.delete(guildId);
}

module.exports = { getPrefix, setPrefix, forget };
