import { useEffect, useState } from 'react';
import { readStored, store } from './storage';

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'shardlens:theme';

export function storedTheme(): Theme {
  const theme = readStored(KEY);
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

/** `system` follows `prefers-color-scheme`; `light` and `dark` pin the tokens with `data-theme`. */
export function applyTheme(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState(storedTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return [
    theme,
    (next) => {
      setTheme(next);
      store(KEY, next);
    },
  ];
}
