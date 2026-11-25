const mongoose = require('mongoose');
const { defaultPrefix } = require('../config.json');

const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  prefix: { type: String, default: defaultPrefix },
  modLogChannel: { type: String, default: null },
  joinedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('GuildConfig', guildConfigSchema);
