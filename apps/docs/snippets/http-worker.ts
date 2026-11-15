import { createShardlensHttp, type WaitUntilContext } from '@shardlens/http';
import type { APIInteraction, APIInteractionResponse } from 'discord-api-types/v10';

/** Worker bindings (vars and secrets), or `process.env` and `Deno.env.toObject()` on other runtimes. */
export interface Env {
  /** Developer Portal → General Information → Public Key. */
  DISCORD_PUBLIC_KEY?: string | undefined;
  /** Your collector, for example `https://stats.example.com`. */
  SHARDLENS_URL?: string | undefined;
  /** `slk_ingest_…`. Keep it in a secret. */
  SHARDLENS_INGEST_KEY?: string | undefined;
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
async function answer(interaction: APIInteraction, _ctx?: WaitUntilContext): Promise<APIInteractionResponse> {
  if (interaction.type === 1) return { type: 1 }; // PING: answered, not recorded
  if (interaction.type === 2 && interaction.data.name === 'ping') {
    return { type: 4, data: { content: 'Pong!', flags: 64 } };
  }
  return { type: 4, data: { content: 'Unknown command', flags: 64 } };
}

/** The bot, for any runtime: Workers below, Deno, Bun and Node through their own servers. */
export function createBot(env: Env) {
  // Nothing runs until the first interaction: no timers, no network.
  const lens = createShardlensHttp({ endpoint: env.SHARDLENS_URL, apiKey: env.SHARDLENS_INGEST_KEY });
  const handle = lens.wrapInteractionHandler(answer);
  return {
    lens,
    async fetch(request: Request, ctx?: WaitUntilContext): Promise<Response> {
      if (request.method !== 'POST') return new Response('Not found', { status: 404 });
      const body = await request.text();
      if (!(await verified(request, body, env.DISCORD_PUBLIC_KEY ?? ''))) {
        return new Response('Bad request signature', { status: 401 });
      }
      return Response.json(await handle(JSON.parse(body) as APIInteraction, ctx));
    },
  };
}

// Cloudflare Workers: secrets arrive with the first request, so the bot is created then.
let bot: ReturnType<typeof createBot> | undefined;
export default {
  fetch(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
    bot ??= createBot(env);
    return bot.fetch(request, ctx);
  },
};
