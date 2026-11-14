import { useMemo, useState } from 'react';

export const PRESETS = [
  { id: '24h', label: '24 hours', days: 1, interval: 'hour' },
  { id: '7d', label: '7 days', days: 7, interval: 'day' },
  { id: '30d', label: '30 days', days: 30, interval: 'day' },
  { id: '90d', label: '90 days', days: 90, interval: 'day' },
] as const;

export type PresetId = (typeof PRESETS)[number]['id'];

const KEY = 'shardlens:range';

function initial(): PresetId {
  try {
    const stored = localStorage.getItem(KEY);
    if (PRESETS.some((p) => p.id === stored)) return stored as PresetId;
  } catch {
    // storage may be unavailable
  }
  return '30d';
}

/** The page-wide time range (remembered per viewer), rounded to the minute so queries cache. */
export function useRange() {
  const [id, setIdState] = useState<PresetId>(initial);
  const setId = (next: PresetId) => {
    setIdState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // ignore
    }
  };
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[2];
  const range = useMemo(() => {
    const to = Math.ceil(Date.now() / 60_000) * 60_000;
    return { from: new Date(to - preset.days * 86_400_000).toISOString(), to: new Date(to).toISOString() };
  }, [preset.days]);
  return { id, setId, preset, range, interval: preset.interval };
}
