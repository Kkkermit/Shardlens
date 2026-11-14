// Runs on your dashboard's server. The read key must never reach a browser.
const SHARDLENS_URL = process.env.SHARDLENS_URL!; // https://stats.example.com
const READ_KEY = process.env.SHARDLENS_READ_KEY!; // slk_read_…

export async function shardlensQuery<T>(spec: Record<string, unknown>): Promise<T> {
  const res = await fetch(new URL('/v1/query', SHARDLENS_URL), {
    method: 'POST',
    headers: { authorization: `Bearer ${READ_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(spec),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Shardlens answered ${res.status}`);
  return (await res.json()) as T;
}

const lastDays = (days: number) => ({
  from: new Date(Date.now() - days * 86_400_000).toISOString(),
  to: new Date().toISOString(),
});

interface CommandRow {
  command: string;
  runs: number;
  changePct: number | null;
  errorRate: number | null;
  p95Ms: number | null;
  servers: number;
  uniqueUsersThisPeriod: number | null;
}

// A route on your own backend, for example GET /api/stats/commands. This is a Web-standard handler, so it works as a
// Next.js route handler, in Hono, on Cloudflare Workers and in Bun.
export async function GET(): Promise<Response> {
  const { rows } = await shardlensQuery<{ rows: CommandRow[] }>({ kind: 'commands', range: lastDays(7) });
  return Response.json(rows.slice(0, 10), { headers: { 'cache-control': 'private, max-age=60' } });
}

// One server's most used commands, for a per-server page in your dashboard.
export function topCommandsIn(guildId: string) {
  return shardlensQuery<{ rows: { key: string; value: number }[] }>({
    kind: 'top',
    metric: 'interactions',
    groupBy: 'command',
    filters: [{ field: 'guild', value: guildId }],
    range: lastDays(30),
    limit: 10,
  });
}

// Commands per day, ready for any chart library.
export function commandsPerDay() {
  return shardlensQuery<{ points: { t: string; value: number }[] }>({
    kind: 'series',
    metric: 'interactions',
    interval: 'day',
    range: lastDays(30),
  });
}
