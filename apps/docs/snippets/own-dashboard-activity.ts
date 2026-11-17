// Runs on your dashboard's server, behind your own sign-in: these answers name people.
import { createShardlensClient } from '@shardlens/client';

const shardlens = createShardlensClient({
  endpoint: process.env.SHARDLENS_URL!,
  apiKey: process.env.SHARDLENS_ACTIVITY_KEY!, // slk_activity_…: who ran what, and everything a read key reads
});

// The latest failed runs in one server, with who ran each. Pass `nextBefore` back as `before` for the next page.
export function failedRunsIn(guildId: string, before?: string | null) {
  return shardlens.activity.log({ guild: guildId, outcome: 'failed', limit: 50, before });
}

// Everything one user ran, newest first: for a support ticket or an abuse report. Exact IDs only.
export function runsBy(userId: string) {
  return shardlens.activity.log({ user: userId });
}

// The most active users of the last 7 days, as counts.
export function busiestUsers() {
  return shardlens.activity.topUsers('7d');
}
