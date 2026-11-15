const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** A number that can be shown: not `null`, `undefined`, `NaN` or infinite. */
export const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** A whole number in full, for chart axes and bars. */
export const count = (n: number) => whole.format(n);

export function num(n: number | null | undefined): string {
  if (!finite(n)) return '—';
  return Math.abs(n) >= 100_000 ? compact.format(n) : whole.format(n);
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (!finite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function ms(n: number | null | undefined): string {
  if (!finite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} s` : `${Math.round(n)} ms`;
}

function toDate(value: string | Date): Date | undefined {
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function formatDate(value: string | Date | null | undefined, options: Intl.DateTimeFormatOptions): string {
  const d = value ? toDate(value) : undefined;
  return d ? new Intl.DateTimeFormat(undefined, options).format(d) : '—';
}

export const date = (value: string | Date | null | undefined, timeZone = 'UTC') =>
  formatDate(value, { dateStyle: 'medium', timeZone });

export const dateTime = (value: string | Date | null | undefined, timeZone = 'UTC') =>
  formatDate(value, { dateStyle: 'medium', timeStyle: 'short', timeZone });

export function ago(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const d = toDate(value);
  if (!d) return '—';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Labels for coded dimensions, so the UI never shows raw codes. */
const LABELS: Record<string, Record<string, string>> = {
  context: { '0': 'Server', '1': 'Bot DM', '2': 'Private channel' },
  channel: {
    '0': 'Text channel',
    '1': 'DM',
    '2': 'Voice channel chat',
    '3': 'Group DM',
    '5': 'Announcement channel',
    '10': 'Announcement thread',
    '11': 'Public thread or forum post',
    '12': 'Private thread',
    '13': 'Stage channel chat',
    '15': 'Forum',
    '16': 'Media channel',
  },
  install: { guild: 'Server install', user: 'User install', both: 'Both' },
  tier: { admin: 'Admins', manager: 'Managers', member: 'Members', dm: 'DMs' },
  outcome: { ok: 'OK', error: 'Error', timeout: 'Missed 3 s deadline', no_response: 'No response' },
  kind: {
    chat_input: 'Slash command',
    user_context: 'User menu',
    message_context: 'Message menu',
    primary_entry_point: 'Entry point',
    button: 'Button',
    select: 'Select menu',
    modal_submit: 'Modal',
    autocomplete: 'Autocomplete',
    message_command: 'Prefix command',
  },
};

export function label(dimension: string, key: string | null | undefined): string {
  if (key === null || key === undefined || key === '') return '(none)';
  return LABELS[dimension]?.[key] ?? key;
}
