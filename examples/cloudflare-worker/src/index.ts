// An HTTP-interaction bot on Cloudflare Workers. Discord POSTs each interaction here; the Worker verifies the
// signature, answers, and Shardlens records the interaction and sends it after the response, through ctx.waitUntil.
import { createShardlensHttp, type WaitUntilContext } from '@shardlens/http';
import type { APIInteraction, APIInteractionResponse } from 'discord-api-types/v10';

interface Env {
  /** Developer Portal → General Information → Public Key. A secret: `npx wrangler secret put DISCORD_PUBLIC_KEY`. */
  DISCORD_PUBLIC_KEY: string;
  /** Your collector, set in wrangler.toml. */
  SHARDLENS_URL: string;
  /** `slk_ingest_…`. A secret: `npx wrangler secret put SHARDLENS_INGEST_KEY`. */
  SHARDLENS_INGEST_KEY: string;
}

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/** Discord signs every request with Ed25519, and checks that the endpoint refuses a bad signature with 401. */
async function verified(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

// Shardlens finds `ctx` among the arguments, and sends this interaction's events through `ctx.waitUntil`.
async function answer(interaction: APIInteraction, _ctx: WaitUntilContext): Promise<APIInteractionResponse> {
  if (interaction.type === 1) return { type: 1 }; // PING: answered, not recorded
  if (interaction.type === 2 && interaction.data.name === 'ping') {
    return { type: 4, data: { content: 'Pong from a Worker!', flags: 64 } };
  }
  return { type: 4, data: { content: 'Unknown command', flags: 64 } };
}

// Secrets arrive with the first request, so Shardlens is created then. Nothing runs before the first interaction.
let handle: ((interaction: APIInteraction, ctx: WaitUntilContext) => Promise<APIInteractionResponse>) | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const body = await request.text();
    if (!(await verified(request, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response('Bad request signature', { status: 401 });
    }
    handle ??= createShardlensHttp({
      endpoint: env.SHARDLENS_URL,
      apiKey: env.SHARDLENS_INGEST_KEY,
      instance: 'worker-example',
    }).wrapInteractionHandler(answer);
    return Response.json(await handle(JSON.parse(body) as APIInteraction, ctx));
  },
};
