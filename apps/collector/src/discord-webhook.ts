const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);
const DISCORD_WEBHOOK_PATH = /^\/api\/(v\d+\/)?webhooks\/\d{17,20}\/[\w-]+$/;

/**
 * Alerts and reports go to Discord webhook URLs over HTTPS and nowhere else, so the collector can't be used to reach
 * internal services (SSRF). Ports, credentials, query strings and fragments are refused.
 */
export function isDiscordWebhookUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    DISCORD_WEBHOOK_HOSTS.has(u.hostname) &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    u.search === '' &&
    u.hash === '' &&
    DISCORD_WEBHOOK_PATH.test(u.pathname)
  );
}

/** `https://discord.com/api/webhooks/1234…/•••`: enough to recognise, never enough to use. */
export function maskWebhook(url: string): string {
  const m = /^(https:\/\/[^/]+\/api\/(?:v\d+\/)?webhooks\/)(\d{4})\d+\//.exec(url);
  return m ? `${m[1]}${m[2]}…/•••` : '•••';
}

/** A stored, encrypted webhook URL, masked. Just `•••` when it can no longer be decrypted (a changed settings key). */
export function maskStoredWebhook(cipher: { decrypt(blob: Buffer): string }, blob: Buffer): string {
  try {
    return maskWebhook(cipher.decrypt(blob));
  } catch {
    return '•••';
  }
}

interface DiscordMessage {
  title: string;
  /** Discord Markdown. */
  body: string;
  link: string;
  critical: boolean;
}

/**
 * Posts a message to a Discord webhook as a Components V2 message, falling back to plain content if the webhook
 * refuses it. The URL is checked again and redirects are refused, so a stored URL can't be turned into an SSRF probe.
 * Mentions are disabled.
 */
export async function postToDiscordWebhook(
  webhookUrl: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  if (!isDiscordWebhookUrl(webhookUrl)) return { ok: false, error: 'webhook not allowed' };
  const post = (url: string, body: unknown) =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  try {
    const v2 = await post(`${webhookUrl}?with_components=true`, {
      flags: 1 << 15,
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 17,
          accent_color: message.critical ? 0xd03b3b : 0x2a78d6,
          components: [
            { type: 10, content: `### ${message.title}` },
            { type: 10, content: message.body },
            { type: 10, content: `[Open in Shardlens](${message.link})` },
          ],
        },
      ],
    });
    if (v2.ok) return { ok: true };
    if (v2.status !== 400) return { ok: false, error: `discord returned ${v2.status}` };
    const plain = await post(webhookUrl, {
      content: `**${message.title}**\n${message.body}\n${message.link}`.slice(0, 2_000),
      allowed_mentions: { parse: [] },
    });
    return plain.ok ? { ok: true } : { ok: false, error: `discord returned ${plain.status}` };
  } catch (error) {
    return { ok: false, error: requestFailure(error) };
  }
}

/**
 * Why a request never got an answer, for the alert history and the report's last error. Only the error's name and
 * code: fetch's messages can name the URL, and a webhook URL is a credential.
 */
function requestFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'request failed';
  if (error.name === 'TimeoutError') return 'Discord did not answer within 10 seconds';
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? `could not reach Discord (${code})`
    : 'could not reach Discord';
}
