const formats = new Map<string, Intl.NumberFormat>();

/** One cached formatter per locale and options. Every number on a page goes through these, so separators agree. */
function numbers(options: Intl.NumberFormatOptions, locale?: string): Intl.NumberFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}

/** A number that can be shown: not `null`, `undefined`, `NaN` or infinite. */
export const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** A whole number in full, for chart axes and bars. */
export const count = (n: number) => numbers({ maximumFractionDigits: 0 }).format(n);

export function num(n: number | null | undefined, locale?: string): string {
  if (!finite(n)) return '—';
  return Math.abs(n) >= 100_000
    ? numbers({ notation: 'compact', maximumFractionDigits: 1 }, locale).format(n)
    : numbers({ maximumFractionDigits: 0 }, locale).format(n);
}

/** A number as entered (a threshold): up to three decimals, never rounded to a whole one. */
export function number(n: number | null | undefined, locale?: string): string {
  if (!finite(n)) return '—';
  return numbers({ maximumFractionDigits: 3 }, locale).format(n);
}

/** A number with exactly `digits` decimals. */
export function decimal(n: number | null | undefined, digits: number, locale?: string): string {
  if (!finite(n)) return '—';
  return numbers({ minimumFractionDigits: digits, maximumFractionDigits: digits }, locale).format(n);
}

/** A share (`0.042` is 4.2%). */
export function pct(n: number | null | undefined, digits = 1, locale?: string): string {
  if (!finite(n)) return '—';
  return numbers({ style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }, locale).format(n);
}

/** An amount of money in a currency named by its ISO code (`EUR`), with the code itself for one Intl doesn't know. */
export function money(amount: number, currency: string, locale?: string): string {
  try {
    return numbers({ style: 'currency', currency }, locale).format(amount);
  } catch {
    return `${decimal(amount, 2, locale)} ${currency}`;
  }
}

/** A duration in milliseconds: `412 ms`, `3.3 s`. */
export function ms(n: number | null | undefined, locale?: string): string {
  if (!finite(n)) return '—';
  if (n < 1000) return `${numbers({ maximumFractionDigits: 0 }, locale).format(n)} ms`;
  const digits = n >= 10_000 ? 0 : 1;
  return `${numbers({ minimumFractionDigits: digits, maximumFractionDigits: digits }, locale).format(n / 1000)} s`;
}

/** Whole characters as people see them: an emoji or a flag is one, never half of a surrogate pair. */
function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') return Array.from(text);
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
}

/** The first `max` characters of `text`, for an avatar placeholder. */
export const firstCharacters = (text: string, max: number) => graphemes(text).slice(0, max).join('');

/** Up to `max` initials of a name: the first character of each word. */
export function initials(name: string, max: number): string {
  return name
    .split(/\s+/)
    .map((word) => graphemes(word)[0] ?? '')
    .filter((first) => first !== '')
    .slice(0, max)
    .join('')
    .toUpperCase();
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

/** A calendar day the collector sends as `YYYY-MM-DD` (a period's start), in the viewer's locale. */
export const day = (value: string | null | undefined, locale?: string) => {
  const d = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? toDate(`${value}T00:00:00Z`) : undefined;
  return d ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d) : value || '—';
};

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

/**
 * `ago` for the start of an hourly bucket (the Commands page's "last used"): a run in the current hour reads "this
 * hour", not the minutes since the hour began.
 */
export function agoHour(value: string | Date | null | undefined): string {
  const d = value ? toDate(value) : undefined;
  if (d && Date.now() - d.getTime() < 3_600_000) return 'this hour';
  return ago(value);
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

/**
 * A name people chose (an alert, a report, a key), quoted inside a sentence that is shown as plain text: a status
 * message or a confirmation. Isolated like `Name`, so a right-to-left override in it can't reorder the sentence.
 */
export const quoted = (name: string) => `“\u2068${name}\u2069”`;

/** A command's name as people type it: `/ping` once it has run as a slash command, plain for prefix commands and menus. */
export function commandLabel(name: string, kinds: readonly string[]): string {
  return kinds.includes('chat_input') ? `/${name}` : name;
}
