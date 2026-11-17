/**
 * Every failure of the client: an answer other than 2xx, no answer at all, or options it can't work with. The message
 * never contains the key.
 */
export class ShardlensClientError extends Error {
  /** The HTTP status of the collector's answer. `0` when there was none: a timeout, a network failure, bad options. */
  readonly status: number;
  /**
   * The collector's error code (`unauthorized`, `invalid_query`, `activity_key_required`, `audit_mode_off`,
   * `rate_limited`…), or `http_<status>` for an answer without one. Without an answer: `timeout`, `network` or
   * `invalid_options`. `invalid_response` is a 2xx answer that isn't the collector's JSON.
   */
  readonly code: string;
  /** How long the collector asks to wait before trying again, from `Retry-After` (a 429, or a busy live stream). */
  readonly retryAfterSeconds: number | undefined;
  /** The collector's ID for a request it failed on (a 500), to find it in the collector's log. */
  readonly requestId: string | undefined;

  constructor(
    message: string,
    details: {
      status: number;
      code: string;
      retryAfterSeconds?: number | undefined;
      requestId?: string | undefined;
      cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ShardlensClientError';
    this.status = details.status;
    this.code = details.code;
    this.retryAfterSeconds = details.retryAfterSeconds;
    this.requestId = details.requestId;
  }
}

/** What the collector means by the codes this client can meet, for answers that carry no message of their own. */
const EXPLAINED: Record<string, string> = {
  unauthorized: 'The collector refused the key: it is wrong, revoked or belongs to another collector.',
  activity_key_required: 'The activity log needs an activity key (slk_activity_…): a read key cannot see who ran what.',
  audit_mode_off: 'The collector is not in audit mode, so it has no activity log.',
  rate_limited: 'Too many requests to the collector.',
  busy: 'The collector has too many live streams open.',
  internal: 'The collector ran into an error.',
};

/** `Retry-After` as seconds: the header holds either a number of seconds or an HTTP date. */
function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** The fields an `invalid_request` answer names, as `range.from: Invalid ISO datetime`. */
function issueText(issues: unknown): string {
  if (!Array.isArray(issues)) return '';
  return issues
    .slice(0, 5)
    .map((issue: { path?: unknown; message?: unknown }) => {
      const path = Array.isArray(issue?.path) ? issue.path.join('.') : '';
      const message = typeof issue?.message === 'string' ? issue.message : '';
      return path && message ? `${path}: ${message}` : path || message;
    })
    .filter((text) => text !== '')
    .join('; ');
}

/** The error for an answer other than 2xx. Reads the body, so the connection is released. */
export async function answerError(res: Response): Promise<ShardlensClientError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
    requestId?: unknown;
    issues?: unknown;
  } | null;
  const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
  const requestId = typeof body?.requestId === 'string' ? body.requestId : undefined;
  const issues = issueText(body?.issues);
  let message: string;
  if (typeof body?.message === 'string') message = body.message;
  else if (issues) message = `The collector refused the request (${code}): ${issues}`;
  else if (Object.hasOwn(EXPLAINED, code)) message = EXPLAINED[code] as string;
  else if (res.status >= 300 && res.status < 400) {
    message = `The collector answered ${res.status}, a redirect, which the client doesn't follow: set url to the collector's own address.`;
  } else message = `The collector answered ${res.status} (${code}).`;
  if (requestId) message += ` Request ID: ${requestId}`;
  return new ShardlensClientError(message, {
    status: res.status,
    code,
    retryAfterSeconds: retryAfterSeconds(res.headers.get('retry-after')),
    requestId,
  });
}
