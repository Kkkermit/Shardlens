import type { ChatInputCommandInteraction, SharedSlashCommand } from 'discord.js';
import echo from './echo.js';
import ping from './ping.js';
import roulette from './roulette.js';
import server from './server.js';
import stats from './stats.js';

export interface Command {
  data: SharedSlashCommand;
  run(interaction: ChatInputCommandInteraction): Promise<unknown>;
}

// add new commands here AND run `npm run deploy` afterwards
export const commands = new Map<string, Command>(
  [ping, server, stats, echo, roulette].map((command) => [command.data.name, command]),
);
