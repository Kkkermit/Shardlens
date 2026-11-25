const mongoose = require('mongoose');

// every ban/kick the bot does, so mods can look things up later
const modCaseSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    action: { type: String, enum: ['ban', 'kick', 'unban'], required: true },
    userId: String,
    moderatorId: String,
    reason: String,
  },
  { timestamps: true },
);

module.exports = mongoose.model('ModCase', modCaseSchema);
