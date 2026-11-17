/** How an interaction ended. `timeout`: the first response missed Discord's 3-second deadline. */
export type ActivityOutcome = 'ok' | 'error' | 'timeout' | 'no_response';

/** Narrows the activity log. Every filter is optional; together they must all match. */
export interface ActivityLogFilters {
  /** Rows at or after this time: an ISO 8601 date-time with an offset. */
  from?: string | undefined;
  /** Rows before this time. */
  to?: string | undefined;
  /** Paging: the `nextBefore` of the page before (`null` is the same as leaving it out), or a time to start below. */
  before?: string | null | undefined;
  /** A command's name, without the slash. */
  command?: string | undefined;
  /** A server's ID. */
  guild?: string | undefined;
  /** A user's Discord ID. The collector records the lookup in its access log. */
  user?: string | undefined;
  /** One outcome, or `failed` for every outcome but `ok`. */
  outcome?: ActivityOutcome | 'failed' | undefined;
  /** Rows per page: 1 to 200, default 50. */
  limit?: number | undefined;
}

/** One interaction in the activity log: who ran what, where, and how it ended. */
export interface ActivityRow {
  interactionId: string;
  ts: string;
  guildId: string | null;
  /** Text chosen by the server's owner: render it as text. `null` for a server the collector has no profile of. */
  guildName: string | null;
  /** `chat_input`, `button`, `select`, `modal_submit`, `message_command`… */
  kind: string;
  command: string | null;
  sub: string | null;
  customId: string | null;
  outcome: ActivityOutcome;
  /** Time to the first response, in milliseconds. */
  ackMs: number | null;
  /** `null` when the row was written under another audit key and can't be read with this one. */
  userId: string | null;
  /** Text chosen by the user: render it as text. `null` when the bot sends IDs only. */
  username: string | null;
  /** Discord's avatar hash. */
  avatar: string | null;
}

/** One page of the activity log, newest first. */
export interface ActivityLogPage {
  rows: ActivityRow[];
  /**
   * Pass as `before` for the next, older page. `null` when this page has fewer rows than `limit`; a full page can be
   * followed by an empty one.
   */
  nextBefore: string | null;
}

/** The users who ran the most in a window: up to 25. */
export interface ActivityTopUsers {
  window: '24h' | '7d';
  rows: { userId: string | null; runs: number }[];
}

const FILTERS = ['from', 'to', 'before', 'command', 'guild', 'user', 'outcome', 'limit'] as const;

/** The log's path with its filters as the query string, where the collector reads them. */
export function activityLogPath(filters: ActivityLogFilters): string {
  const params = new URLSearchParams();
  for (const name of FILTERS) {
    const value = filters[name];
    if (value !== undefined && value !== null) params.set(name, String(value));
  }
  const query = params.toString();
  return query ? `/v1/audit/log?${query}` : '/v1/audit/log';
}
