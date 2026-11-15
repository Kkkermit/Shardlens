/** Warns on the console (the exporter has no logger of its own), without ever throwing into the bot. */
export function warn(message: string): void {
  try {
    console.warn(`Shardlens: ${message}`);
  } catch {
    // a broken console must not break the bot
  }
}
