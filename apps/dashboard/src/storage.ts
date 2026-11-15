/**
 * Per-viewer preferences in localStorage. Storage throws in some private windows and when site data is blocked; the
 * dashboard then works the same and only forgets the choice.
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // see readStored
  }
}
