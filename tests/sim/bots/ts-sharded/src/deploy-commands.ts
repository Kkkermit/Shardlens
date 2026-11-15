import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commands = [];
for (const folder of fs.readdirSync(path.join(__dirname, 'commands'))) {
  for (const file of fs.readdirSync(path.join(__dirname, 'commands', folder)).filter((f) => f.endsWith('.js'))) {
    const { default: command } = await import(pathToFileURL(path.join(__dirname, 'commands', folder, file)).href);
    commands.push(command.data.toJSON());
  }
}
const rest = new REST().setToken(process.env.DISCORD_TOKEN!);
await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), { body: commands });
console.log(`Successfully reloaded ${commands.length} application (/) commands.`);
