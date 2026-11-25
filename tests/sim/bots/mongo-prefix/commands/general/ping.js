module.exports = {
  name: 'ping',
  aliases: ['p'],
  description: 'Check if the bot is alive',
  async execute(message, _args, client) {
    await message.reply(`🏓 Pong! (websocket: ${client.ws.ping}ms)`);
  },
};
