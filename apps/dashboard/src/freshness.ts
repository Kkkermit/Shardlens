/**
 * How often the Overview asks the collector again while it stays open. Its totals come from rollups, a minute behind
 * the live tiles; until the first events show, it asks every few seconds, so someone who has just started their bot
 * sees "waiting for the first events" end without reloading.
 */
export function overviewRefreshMs(overview: { lastEventAt: string | null } | undefined): number {
  return overview?.lastEventAt ? 60_000 : 10_000;
}
