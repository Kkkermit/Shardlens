// An HTTP-interaction bot on Cloudflare Workers. Discord POSTs each interaction here; we verify the signature, answer,
// and Shardlens records it. Nothing runs at module scope except creating the (idle) Shardlens instance.
import { createShardlensHttp } from '@shardlens/http';
import type { APIInteraction, APIInteractionResponse } from 'discord-api-types/v10';

interface Env {
  DISCORD_PUBLIC_KEY: string;
  SHARDLENS_URL: string;
  SHARDLENS_INGEST_KEY: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

let lens: ReturnType<typeof createShardlensHttp> | undefined;
const shardlens = (env: Env) =>
  (lens ??= createShardlensHttp({ endpoint: env.SHARDLENS_URL, apiKey: env.SHARDLENS_INGEST_KEY, instance: 'worker' }));

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/** Discord signs every request with Ed25519; reject anything that doesn't verify. */
async function verified(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;
  const key = await crypto.subtle.importKey('raw', hex(publicKey), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + body));
}

// The wrapped handler receives the same arguments you pass in; Shardlens finds `ctx.waitUntil` among them.
async function answer(interaction: APIInteraction, _ctx: ExecutionContext): Promise<APIInteractionResponse> {
  if (interaction.type === 1) return { type: 1 }; // PING
  if (interaction.type === 2 && interaction.data.name === 'ping') {
    return { type: 4, data: { content: 'Pong from a Worker!', flags: 64 } };
  }
  return { type: 4, data: { content: 'Unknown command', flags: 64 } };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });
    const body = await request.text();
    if (!(await verified(request, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });
    const handle = shardlens(env).wrapInteractionHandler(answer);
    // ctx has waitUntil, so Shardlens sends its events after the response, without delaying it.
    return Response.json(await handle(JSON.parse(body) as APIInteraction, ctx));
  },
};
