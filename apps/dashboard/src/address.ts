/**
 * Search parameters as plain text. The router's own parser reads each value as JSON, which turns the Discord ID in a
 * hand-written link (`?guild=123456789012345678`) into a number, and a number that long is rounded to a different ID.
 */
export function parseSearch(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) out[key] = unquoted(value);
  return out;
}

/** Links made by the JSON parser put text that reads as JSON in quotes (`q="123"`); those still open as intended. */
function unquoted(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    params.set(key, text.startsWith('"') ? JSON.stringify(text) : text);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}
