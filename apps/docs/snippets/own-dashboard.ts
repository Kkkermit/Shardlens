// Runs on your dashboard's server. A key must never reach a browser.
import { createShardlensClient, lastDays } from '@shardlens/client';

const shardlens = createShardlensClient({
  endpoint: process.env.SHARDLENS_URL!, // https://stats.example.com
  apiKey: process.env.SHARDLENS_READ_KEY!, // slk_read_…
});

// A route on your own backend, for example GET /api/stats/commands. This is a Web-standard handler, so it works as a
// Next.js route handler, in Hono, on Cloudflare Workers and in Bun.
export async function GET(): Promise<Response> {
  const { rows } = await shardlens.commands({ range: lastDays(7) });
  return Response.json(rows.slice(0, 10), { headers: { 'cache-control': 'private, max-age=60' } });
}

// One server's most used commands, for a per-server page in your dashboard.
export function topCommandsIn(guildId: string) {
  return shardlens.top({
    metric: 'interactions',
    groupBy: 'command',
    filters: [{ field: 'guild', value: guildId }],
    range: lastDays(30),
    limit: 10,
  });
}

// The commands that fail in one server: errors, missed 3-second deadlines and runs that got no response.
export function failingCommandsIn(guildId: string) {
  return shardlens.top({
    metric: 'interactions',
    groupBy: 'command',
    filters: [
      { field: 'guild', value: guildId },
      { field: 'outcome', op: 'in', value: ['error', 'timeout', 'no_response'] },
    ],
    range: lastDays(30),
    limit: 10,
  });
}

// One command in depth, for a per-command page: outcomes, how often it deferred, subcommands, options and the servers
// that use it most. It reads single events, which are kept for 35 days unless Settings says otherwise (7 to 90).
export function commandDetail(name: string) {
  return shardlens.command(name, { range: lastDays(30) });
}

// Commands per day, ready for any chart library.
export function commandsPerDay() {
  return shardlens.series({ metric: 'interactions', interval: 'day', range: lastDays(30) });
}
