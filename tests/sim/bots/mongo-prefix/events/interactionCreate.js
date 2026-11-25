const { Events } = require('discord.js');
const Warning = require('../models/Warning');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('confirm:warn:')) {
        const modId = interaction.customId.split(':')[2];
        if (interaction.user.id !== modId) {
          return interaction.reply({ content: "That's not your button!", ephemeral: true });
        }

        const pending = client.pendingWarns.get(modId);
        if (!pending) {
          return interaction.update({ content: 'This warning expired, run the command again.', components: [] });
        }
        client.pendingWarns.delete(modId);

        await Warning.create({ ...pending, moderatorId: modId });
        await interaction.update({ content: `Confirmed. <@${pending.userId}> has been warned.`, components: [] });
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.slashCommands.get(interaction.commandName);
    if (!command) return;

    try {
      await client.lens.wrap((i) => command.execute(i, client))(interaction);
    } catch (error) {
      console.error(error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
      } else {
        await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
      }
    }
  },
};
