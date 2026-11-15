import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

/** The variables set in `.env` text. Empty values count as unset, as they do for the collector. */
export function envValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (value?.trim()) values[name] = value.trim();
  }
  return values;
}

/**
 * The variables set in a `.env` file, read without touching `process.env`. `undefined` when the file doesn't exist;
 * other read errors are thrown.
 */
export async function readEnvFile(file: string): Promise<Record<string, string> | undefined> {
  try {
    return envValues(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * `.env` text with these variables set in place, so comments, quoting and every other setting stay as they were. A
 * variable that is only there commented out (`# NAME=…`) is uncommented; one that isn't there at all is appended.
 */
export function setEnvVariables(text: string, updates: Record<string, string>): string {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const linesOf = (name: string, commented: boolean) => {
    const pattern = new RegExp(`^\\s*${commented ? '#\\s*' : ''}(?:export\\s+)?${name}\\s*=`);
    return lines.flatMap((line, i) => (pattern.test(line) ? [i] : []));
  };
  for (const [name, value] of Object.entries(updates)) {
    const set = linesOf(name, false);
    const at = set.length > 0 ? set : linesOf(name, true).slice(0, 1);
    if (at.length === 0) lines.push(`${name}=${value}`);
    for (const i of at) lines[i] = `${name}=${value}`;
  }
  return `${lines.join('\n')}\n`;
}
