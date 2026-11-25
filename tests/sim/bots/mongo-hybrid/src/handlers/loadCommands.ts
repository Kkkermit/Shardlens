import fs from 'node:fs';
import path from 'node:path';
import { Collection } from 'discord.js';
import type { Command } from '../types';

export function loadCommands(): Collection<string, Command> {
  const commands = new Collection<string, Command>();
  const dir = path.join(__dirname, '..', 'commands');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const command: Command = require(path.join(dir, file)).default;
    if (!command?.data) {
      console.warn(`[WARN] ${file} does not export a command`);
      continue;
    }
    commands.set(command.data.name, command);
  }
  return commands;
}
