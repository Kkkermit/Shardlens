// A tiny opt-out store in a JSON file. Use your bot's database in production.
import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../opt-outs.json', import.meta.url);

export async function loadOptOuts(): Promise<string[]> {
  try {
    const ids: unknown = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialises writes so concurrent opt-outs don't overwrite each other. */
export function saveOptOut(userId: string, optedOut: boolean): Promise<void> {
  const write = queue.then(async () => {
    const ids = new Set(await loadOptOuts());
    if (optedOut) ids.add(userId);
    else ids.delete(userId);
    await writeFile(FILE, JSON.stringify([...ids]));
  });
  // One failed write must not stop every later one: the queue carries on, the caller still sees the error.
  queue = write.catch(() => undefined);
  return write;
}
