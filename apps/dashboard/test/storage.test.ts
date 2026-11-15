import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, store } from '../src/storage';
import { storedTheme } from '../src/theme';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stored preferences', () => {
  it('reads back what was stored', () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    });
    store('shardlens:range', '7d');
    expect(readStored('shardlens:range')).toBe('7d');
    expect(readStored('missing')).toBeNull();
  });

  it('works without storage (private windows, blocked site data)', () => {
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied });
    expect(() => store('shardlens:theme', 'dark')).not.toThrow();
    expect(readStored('shardlens:theme')).toBeNull();
    expect(storedTheme()).toBe('system');
  });

  it('ignores a stored theme it does not know', () => {
    const theme = { value: 'dark' };
    vi.stubGlobal('localStorage', { getItem: () => theme.value, setItem: () => undefined });
    expect(storedTheme()).toBe('dark');
    theme.value = 'sepia';
    expect(storedTheme()).toBe('system');
  });
});
