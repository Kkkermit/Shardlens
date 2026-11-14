import { createShardlensHttp } from '@shardlens/http';
import type { APIInteraction, APIInteractionResponse } from 'discord-api-types/v10';

interface Env {
  SHARDLENS_URL: string;
  SHARDLENS_INGEST_KEY: string;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
declare function verifyDiscordRequest(request: Request, body: string): Promise<boolean>;

let lens: ReturnType<typeof createShardlensHttp> | undefined;

async function answer(interaction: APIInteraction, _ctx: ExecutionContext): Promise<APIInteractionResponse> {
  if (interaction.type === 1) return { type: 1 }; // PING: answered, not recorded
  return { type: 4, data: { content: 'Pong!', flags: 64 } };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const body = await request.text();
    if (!(await verifyDiscordRequest(request, body))) return new Response('Bad signature', { status: 401 });
    lens ??= createShardlensHttp({ endpoint: env.SHARDLENS_URL, apiKey: env.SHARDLENS_INGEST_KEY });
    const handle = lens.wrapInteractionHandler(answer);
    // ctx.waitUntil sends Shardlens's events after the response, without delaying it.
    return Response.json(await handle(JSON.parse(body) as APIInteraction, ctx));
  },
};
