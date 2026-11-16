import { isSnowflake } from './forms';

/** The activity log's outcome filter: `failed` is every outcome but `ok`. */
export const OUTCOME_FILTERS = ['failed', 'error', 'timeout', 'no_response', 'ok'] as const;

/**
 * The activity log's filters that the address keeps, so a server's or a command's page can link to its rows. The user
 * ID is left out on purpose: an address stays in the browser's history and gets pasted into chats.
 */
export interface ActivitySearch {
  command?: string;
  guild?: string;
  outcome?: (typeof OUTCOME_FILTERS)[number];
}

/** Reads the log's search parameters, dropping what the collector would refuse (the address is anyone's to write). */
export function parseActivitySearch(raw: Record<string, unknown>): ActivitySearch {
  const out: ActivitySearch = {};
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (command !== '' && command.length <= 32) out.command = command;
  const guild = typeof raw.guild === 'string' ? raw.guild.trim() : '';
  if (isSnowflake(guild)) out.guild = guild;
  const outcome = OUTCOME_FILTERS.find((o) => o === raw.outcome);
  if (outcome) out.outcome = outcome;
  return out;
}
