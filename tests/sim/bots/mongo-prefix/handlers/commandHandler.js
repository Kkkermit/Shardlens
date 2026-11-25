const fs = require('node:fs');
const path = require('node:path');

module.exports = (client) => {
  const commandsPath = path.join(__dirname, '..', 'commands');
  for (const folder of fs.readdirSync(commandsPath)) {
    const files = fs.readdirSync(path.join(commandsPath, folder)).filter((file) => file.endsWith('.js'));
    for (const file of files) {
      const command = require(path.join(commandsPath, folder, file));
      if (!command.name) {
        console.log(`[WARN] ${folder}/${file} has no name, skipping`);
        continue;
      }
      command.category = folder;
      client.commands.set(command.name, command);
    }
  }

  const slashPath = path.join(__dirname, '..', 'slash');
  for (const file of fs.readdirSync(slashPath).filter((file) => file.endsWith('.js'))) {
    const command = require(path.join(slashPath, file));
    client.slashCommands.set(command.data.name, command);
  }

  console.log(`Loaded ${client.commands.size} commands and ${client.slashCommands.size} slash commands`);
};
