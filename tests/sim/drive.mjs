// Runs one bot end to end: its fake Discord, its collector (inside the bot, or standalone), the bot, the scripted
// scenario. Then compares what the collector counted with what was sent, and stops the bot the way an owner would.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BOTS } from './bots.mjs';
import { scenarios } from './fake-discord/scenarios.mjs';
import { startNode } from './processes.mjs';

async function until(what, fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

async function counted(query) {
  const top = async (metric, groupBy, filters = []) =>
    Object.fromEntries(
      (await query({ kind: 'top', metric, groupBy, filters, limit: 500 })).rows.map((r) => [r.key, r.count]),
    );
  const byOutcome = async (metric, field) => {
    const out = {};
    for (const key of Object.keys(await top(metric, field))) {
      out[key] = await top(metric, 'outcome', [{ field, value: key }]);
    }
    return out;
  };
  const actual = { growth: {} };
  for (const kind of Object.keys(await top('interactions', 'kind'))) {
    const filter = { field: 'kind', value: kind };
    const bucket = {};
    actual[kind === 'message_command' ? 'prefix' : kind] = bucket;
    for (const command of Object.keys(await top('interactions', 'command', [filter]))) {
      bucket[command] = await top('interactions', 'outcome', [filter, { field: 'command', value: command }]);
    }
  }
  actual.components = await byOutcome('components', 'custom_id');
  actual.modalsSubmitted = await byOutcome('modals.submitted', 'custom_id');
  const shown = await top('modals.shown', 'custom_id');
  actual.modalsShown = Object.fromEntries(Object.entries(shown).map(([id, n]) => [id, { shown: n }]));
  const autocomplete = await top('interactions.autocomplete', 'command');
  actual.autocomplete = Object.fromEntries(Object.entries(autocomplete).map(([name, n]) => [name, { ok: n }]));
  const { daily } = await query({ kind: 'growth', timezone: 'UTC' });
  const sum = (field) => daily.reduce((n, day) => n + (day[field] ?? 0), 0);
  actual.growth.servers = { joins: sum('joins'), leaves: sum('leaves') };
  return actual;
}

const describe = (counts = {}) =>
  Object.entries(counts)
    .filter(([, n]) => n)
    .sort()
    .map(([outcome, n]) => `${outcome} ${n}`)
    .join(', ') || 'nothing';

function compare(expected, actual) {
  const mismatches = [];
  for (const bucket of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    for (const key of new Set([...Object.keys(expected[bucket] ?? {}), ...Object.keys(actual[bucket] ?? {})])) {
      const sent = describe(expected[bucket]?.[key]);
      const got = describe(actual[bucket]?.[key]);
      if (sent !== got) mismatches.push(`${bucket} ${key}: sent ${sent}, counted ${got}`);
    }
  }
  return mismatches;
}

/**
 * Runs `bot`, installed in `dir`. Resolves with what failed, how many events were sent, and the secrets and
 * identities the leak check must not find.
 */
export async function drive(bot, { dir, logs, databases, collectorMain }) {
  const config = BOTS[bot];
  const { appId } = scenarios[bot];
  const log = (name) => join(logs, `${bot}-${name}.log`);
  const sim = async (path, init) => (await fetch(`http://127.0.0.1:${config.discordPort}${path}`, init)).json();
  const collectorUrl = `http://127.0.0.1:${config.collectorPort}`;
  // Shaped like a real token, so redaction that looks for token shapes gets something to find.
  const token = [Buffer.from(appId).toString('base64url'), 'GsImXY', randomBytes(29).toString('base64url')].join('.');
  const here = import.meta.dirname;

  const discord = startNode([join(here, 'fake-discord/server.mjs')], {
    env: { ...process.env, SIM_PORT: String(config.discordPort), SIM_BOT: bot, SIM_SHARDS: String(config.shards ?? 1) },
    log: log('discord'),
  });
  const { guilds } = await until('the fake Discord', () => sim('/_sim/status'), 15_000);

  let collector;
  const standalone = config.embedded
    ? undefined
    : {
        url: collectorUrl,
        ingestKey: `slk_ingest_${randomBytes(32).toString('base64url')}`,
        readKey: `slk_read_${randomBytes(32).toString('base64url')}`,
        env: {
          ...process.env,
          DATABASE_URL: `${databases.postgres}/shardlens`,
          SHARDLENS_SINK_URL: `${databases.mysql}/${config.copy.mysql}`,
          SHARDLENS_PUBLIC_URL: collectorUrl,
          SHARDLENS_APP_ID: appId,
          SHARDLENS_SESSION_SECRET: randomBytes(40).toString('base64url'),
          SHARDLENS_SETTINGS_KEY: randomBytes(32).toString('base64'),
          PORT: String(config.collectorPort),
          HOST: '127.0.0.1',
          LOG_LEVEL: 'info',
        },
      };
  const startCollector = async () => {
    const { env, ingestKey, readKey } = standalone;
    collector = startNode([collectorMain], {
      env: { ...env, SHARDLENS_INGEST_KEY: ingestKey, SHARDLENS_READ_KEY: readKey },
      log: log('collector'),
    });
    await until('the collector', async () => (await fetch(`${collectorUrl}/readyz`)).ok, 60_000);
  };
  if (standalone) await startCollector();

  await config.prepare?.({ guilds });
  const started = Date.now();
  const botProcess = startNode([config.main], {
    cwd: dir,
    env: {
      ...process.env,
      // Not `--require`: a ShardingManager's shard processes don't inherit it, and would call the real Discord.
      NODE_OPTIONS: `--require ${JSON.stringify(join(here, 'fake-discord/preload.cjs'))}`,
      SIM_API: `http://127.0.0.1:${config.discordPort}/api`,
      SIM_LISTEN: config.embedded ? `${config.embedded.port}:${config.collectorPort}` : '',
      DISCORD_TOKEN: token,
      DISCORD_APP_ID: appId,
      DISCORD_CLIENT_ID: appId,
      ...config.env?.({ collector: standalone, databases }),
    },
    log: log('bot'),
  });

  const failures = [];
  const deadline = Date.now() + 240_000;
  let status;
  for (;;) {
    status = await sim('/_sim/status');
    if (status.phase === 'done' || status.phase.startsWith('failed')) break;
    if (status.phase === 'paused:stop-collector') {
      collector.kill('SIGTERM');
      await collector.closed;
      await sim('/_sim/continue', { method: 'POST' });
    } else if (status.phase === 'paused:start-collector') {
      // Long enough that the SDK's sends fail and back off.
      await sleep(8_000);
      await startCollector();
      await sim('/_sim/continue', { method: 'POST' });
    }
    if (botProcess.exitCode !== null || botProcess.signalCode !== null) {
      throw new Error(`the bot exited during the scenario (see ${log('bot')})`);
    }
    if (Date.now() > deadline) throw new Error(`the scenario did not finish (phase: ${status.phase})`);
    await sleep(500);
  }

  let events = 0;
  if (status.phase === 'done') {
    const readKey = config.embedded
      ? JSON.parse(readFileSync(join(dir, config.embedded.dir, 'secrets.json'), 'utf8')).readKey
      : standalone.readKey;
    const range = {
      from: new Date(started - 3_600_000).toISOString(),
      to: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const query = async (spec) => {
      const res = await fetch(`${collectorUrl}/v1/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${readKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ range, ...spec }),
      });
      if (!res.ok) throw new Error(`query ${JSON.stringify(spec)}: ${res.status} ${await res.text()}`);
      return res.json();
    };
    // The SDK sends every 5 seconds and the collector's rollups run every minute.
    let mismatches;
    const settled = Date.now() + 150_000;
    do {
      await sleep(5_000);
      mismatches = compare(status.expected, await counted(query));
    } while (mismatches.length > 0 && Date.now() < settled);
    failures.push(...mismatches);
    for (const bucket of Object.values(status.expected)) {
      for (const outcomes of Object.values(bucket)) events += Object.values(outcomes).reduce((a, b) => a + b, 0);
    }
  } else {
    failures.push(`the scenario ${status.phase}`);
  }

  // Stopped the way an owner would; it must flush and exit cleanly.
  botProcess.kill('SIGINT');
  const exit = await Promise.race([botProcess.closed, sleep(15_000, 'timeout')]);
  if (exit === 'timeout') failures.push('the bot was still running 15 s after SIGINT');
  else if (exit !== 0) failures.push(`the bot exited with ${exit} after SIGINT`);

  const { unknownRoutes, users, interactionTokens } = await sim('/_sim/status');
  for (const route of unknownRoutes) failures.push(`unknown REST route ${route}`);
  for (const child of [collector, discord]) {
    child?.kill('SIGTERM');
    await child?.closed;
  }
  return { failures, events, needles: { token, users, interactionTokens } };
}
