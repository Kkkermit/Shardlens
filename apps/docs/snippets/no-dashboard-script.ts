// Run by hand or on a schedule: this week's commands, without a dashboard.
import { createShardlensClient, lastDays } from '@shardlens/client';

const shardlens = createShardlensClient({
  url: process.env.SHARDLENS_URL!, // https://stats.example.com
  key: process.env.SHARDLENS_READ_KEY!, // slk_read_…
});

const { rows } = await shardlens.commands({ range: lastDays(7) });
for (const row of rows.slice(0, 10)) {
  console.log(`${row.command}: ${row.runs} runs, p95 ${row.p95Ms === null ? '?' : Math.round(row.p95Ms)} ms`);
}
