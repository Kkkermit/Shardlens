export interface ParsedCommand {
  name: string;
  args: string[];
}

/** `!ban @x spam` → { name: 'ban', args: ['@x', 'spam'] }, with the first matching prefix. */
export function parsePrefixed(content: string, prefixes: readonly string[]): ParsedCommand | null {
  const used = prefixes.find((prefix) => prefix && content.startsWith(prefix));
  if (!used) return null;
  const [name, ...args] = content.slice(used.length).trim().split(/\s+/);
  if (!name) return null;
  return { name: name.toLowerCase(), args };
}
