import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed check that doesn't fail `doctor`, such as one it had nothing to check with. */
  warnOnly?: boolean;
}

const TIMEOUT_MS = 5_000;
/** Plain HTTP is allowed to these only, as in the SDK. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function versionAtLeast(version: string, min: [number, number]): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/**
 * Finds a package the way Node does (the nearest `node_modules` upwards) and reads its version from disk, because
 * `require('<name>/package.json')` fails for packages that don't export that path.
 */
async function installedVersion(name: string, from: string): Promise<string | undefined> {
  for (let dir = from; ; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      // not here: keep walking up
    }
    if (dirname(dir) === dir) return undefined;
  }
}

const UNTRUSTED =
  "its certificate isn't trusted. For a private CA, such as Caddy's own for .localhost and .internal names, set " +
  'NODE_EXTRA_CA_CERTS to its root certificate, here and for the bot';

/** What Node's network and TLS error codes mean for the collector at `url`. */
function reason(code: string, url: URL): string | undefined {
  switch (code) {
    case 'ENOTFOUND':
      return `no DNS record for ${url.hostname}`;
    case 'EAI_AGAIN':
      return `the DNS lookup for ${url.hostname} failed`;
    case 'ECONNREFUSED':
      return `nothing accepts connections on ${url.hostname} port ${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
    case 'ECONNRESET':
      return 'the connection was closed before an answer';
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return UNTRUSTED;
    case 'CERT_HAS_EXPIRED':
      return 'its certificate has expired';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `its certificate is not for ${url.hostname}`;
    // What Caddy and most servers answer when they have no certificate for the name asked for.
    case 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR':
    case 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME':
      return `it refused the TLS handshake, usually because it has no certificate for ${url.hostname}`;
    default:
      return undefined;
  }
}

/** Why a request failed: Node says only "fetch failed" and keeps the useful part (a TLS or DNS code) in `cause`. */
function failure(error: unknown, url: URL): string {
  if (!(error instanceof Error)) return 'request failed';
  if (error.name === 'TimeoutError') return `no answer within ${TIMEOUT_MS / 1000} seconds`;
  const cause = (error.cause ?? {}) as { code?: unknown; message?: unknown };
  if (typeof cause.code === 'string') return `${reason(cause.code, url) ?? error.message} (${cause.code})`;
  return typeof cause.message === 'string' ? `${error.message} (${cause.message})` : error.message;
}

/** An answer that isn't a success, in words. */
function answered(res: Response, url: URL): string {
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    const to = URL.parse(location, url.href);
    return to
      ? `redirects to ${to.origin}${to.pathname} (${res.status}): use the address it redirects to`
      : `answered ${res.status}`;
  }
  if (res.status === 404) return 'answered 404: there is no Shardlens collector at this address';
  if (res.status === 429) return 'answered 429 (rate limited): try again in a minute';
  if (res.status >= 502 && res.status <= 504) {
    return `answered ${res.status}: a proxy is there, but the collector behind it isn't answering`;
  }
  return `answered ${res.status}`;
}

async function get(
  f: typeof fetch,
  url: URL,
  headers: Record<string, string> = {},
): Promise<{ res: Response } | { error: string }> {
  try {
    // Not followed: through a redirect the SDK's requests lose their key or their body, so one is reported instead.
    return { res: await f(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }) };
  } catch (error) {
    return { error: failure(error, url) };
  }
}

async function json(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Setup checks. Network calls go only to the collector URL given, and over plain HTTP only to this machine. */
export async function doctor(opts: {
  url?: string;
  key?: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
}): Promise<Check[]> {
  const checks: Check[] = [];
  const f = opts.fetchImpl ?? fetch;
  checks.push({
    name: 'Node.js version',
    ok: versionAtLeast(process.version, [22, 12]),
    detail: `${process.version} (the SDK needs 22.12 or newer)`,
  });

  const cwd = resolve(opts.cwd ?? process.cwd());
  const djs = await installedVersion('discord.js', cwd);
  if (djs) {
    const supported = /^1[45]\./.test(djs);
    checks.push({
      name: 'discord.js',
      ok: supported,
      detail: `${djs}${supported ? '' : ' (Shardlens supports 14.x and 15.x)'}`,
    });
  } else if (await installedVersion('@shardlens/http', cwd)) {
    checks.push({ name: 'discord.js', ok: true, detail: 'not needed: this project uses @shardlens/http' });
  } else {
    checks.push({
      name: 'discord.js',
      ok: false,
      detail: `not found in ${cwd} or the folders above it (run doctor in your bot's folder)`,
      warnOnly: true,
    });
  }

  if (!opts.url) {
    checks.push({
      name: 'Collector',
      ok: false,
      detail: 'pass --url (or set SHARDLENS_URL) to check it',
      warnOnly: true,
    });
    return checks;
  }
  const url = URL.parse(opts.url);
  if (!url) {
    checks.push({ name: 'Collector URL', ok: false, detail: 'not a valid URL' });
    return checks;
  }
  if (url.username || url.password) {
    // The SDK refuses such a URL, and printing it would show the password.
    checks.push({ name: 'Collector URL', ok: false, detail: 'must not contain a user name or password' });
    return checks;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    // The SDK sends nothing to it, and checking the key would send it unencrypted.
    checks.push({
      name: 'Collector URL',
      ok: false,
      detail: `${url.origin} must be HTTPS (plain HTTP only to localhost, for development)`,
    });
    return checks;
  }
  checks.push({
    name: 'Collector URL',
    ok: true,
    detail: url.protocol === 'https:' ? url.origin : `${url.origin} (plain HTTP to this machine: development only)`,
  });

  const health = await get(f, new URL('/healthz', url));
  if ('error' in health) {
    checks.push({ name: 'Collector reachable', ok: false, detail: health.error });
    return checks;
  }
  if (!health.res.ok || (await json(health.res))?.ok !== true) {
    const detail = health.res.ok ? "answered, but it isn't a Shardlens collector" : answered(health.res, url);
    checks.push({ name: 'Collector reachable', ok: false, detail });
    return checks;
  }
  checks.push({ name: 'Collector reachable', ok: true, detail: 'healthy' });

  if (!opts.key) {
    checks.push({
      name: 'Ingest key',
      ok: false,
      detail: 'pass --key (or set SHARDLENS_INGEST_KEY) to check it',
      warnOnly: true,
    });
    return checks;
  }
  if (!/^slk_ingest_[\w-]{43}$/.test(opts.key)) {
    const detail = opts.key.startsWith('slk_read_')
      ? 'this is a read key: the bot needs the ingest key (slk_ingest_…)'
      : 'not an ingest key (slk_ingest_ and 43 more characters)';
    checks.push({ name: 'Ingest key', ok: false, detail });
    return checks;
  }
  const config = await get(f, new URL('/v1/config', url), { authorization: `Bearer ${opts.key}` });
  if ('error' in config) {
    checks.push({ name: 'Ingest key', ok: false, detail: config.error });
    return checks;
  }
  const { res } = config;
  if (res.status === 401 || res.status === 403) {
    checks.push({ name: 'Ingest key', ok: false, detail: `rejected (${res.status}): this collector has no such key` });
    return checks;
  }
  const cfg = res.ok ? await json(res) : undefined;
  if (typeof cfg?.appId !== 'string') {
    checks.push({
      name: 'Ingest key',
      ok: false,
      detail: res.ok ? 'answered without Shardlens settings' : answered(res, url),
    });
    return checks;
  }
  const salt = Array.isArray(cfg.salts) && cfg.salts.length > 0;
  checks.push({ name: 'Ingest key', ok: true, detail: `accepted for application ${cfg.appId}` });
  checks.push({
    name: 'Data mode',
    ok: true,
    detail: `${String(cfg.mode)} mode, salts rotate every ${String(cfg.saltPeriod)}`,
  });
  checks.push({ name: 'Salt available', ok: salt, detail: salt ? 'yes' : 'no salt served' });
  return checks;
}
