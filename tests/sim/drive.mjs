// Runs one bot end to end: its fake Discord, its collector (inside the bot, or standalone), the bot, the scripted
// scenario. Then compares what the collector counted with what was sent, and stops the bot the way an owner would.
// A bot on its own MongoDB runs no collector process: the collector image on the same database reads its numbers, as
// a hosted dashboard would, and `shardlens dashboard` must sign in and read the same.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BOTS } from './bots.mjs';
import { mongoDatabaseUrl, restartDatabase, stopDatabase } from './databases.mjs';
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
 * An owner's own dashboard: the packed client, loaded as an ES module and as CommonJS, must read what the collector's
 * API gives directly. Compared by runs per command, which no longer change once the bot is idle.
 */
async function panelMismatches({ panel, url, readKey, range, appId, query }) {
  const runs = (rows, name, count) => JSON.stringify(rows.map((row) => [row[name], row[count]]).sort());
  const commands = runs((await query({ kind: 'commands' })).rows, 'command', 'runs');
  const top = runs(
    (await query({ kind: 'top', metric: 'interactions', groupBy: 'command', limit: 500 })).rows,
    'key',
    'count',
  );
  const env = { ...process.env, SHARDLENS_URL: url, SHARDLENS_READ_KEY: readKey, SIM_RANGE: JSON.stringify(range) };
  const failures = [];
  for (const script of ['read.mjs', 'read.cjs']) {
    let answer;
    try {
      answer = JSON.parse(
        execFileSync(process.execPath, [script], { cwd: panel, env, encoding: 'utf8', stdio: 'pipe' }),
      );
    } catch (error) {
      failures.push(
        `the panel's ${script} failed: ${String(error.stderr || error.message)
          .trim()
          .slice(-500)}`,
      );
      continue;
    }
    if (answer.appId !== appId) failures.push(`the panel's ${script} read application ${answer.appId}`);
    if (runs(answer.commands, 'command', 'runs') !== commands || runs(answer.top, 'key', 'count') !== top) {
      failures.push(`the panel's ${script} read other runs per command than the collector's API gives`);
    }
  }
  return failures;
}

/** The token of the sign-in link `shardlens dashboard` printed for `port`, once it has printed one. */
const linkToken = (printed, port) =>
  new RegExp(String.raw`Open http://(?:127\.0\.0\.1|localhost):${port}/auth/link/([\w-]{43})(?![\w-])`).exec(
    printed,
  )?.[1];

/**
 * `shardlens dashboard` in the bot's folder, as an owner runs it: from the connection string in the bot's `.env`, it
 * must print a link that signs in once with the owner's rights, read the numbers the image reads, and stop on Ctrl+C.
 */
async function dashboardCommand({ cliMain, dir, mongodb, mongoUrl, port, log, range, query }) {
  writeFileSync(join(dir, '.env'), `${mongodb.env}=${mongoUrl}\n`);
  const env = { ...process.env };
  delete env[mongodb.env];
  const cli = startNode([cliMain, 'dashboard', '--port', String(port)], { cwd: dir, env, log });
  // The link is read from what the owner would see in their terminal, and only its token is used: requests go to the
  // address the sim chose.
  let printed = '';
  cli.stdout.on('data', (d) => {
    printed += d;
  });
  const base = `http://127.0.0.1:${port}`;
  const failures = [];
  try {
    const token = await until('the sign-in link of shardlens dashboard', async () => linkToken(printed, port), 60_000);
    const link = `${base}/auth/link/${token}`;
    const signIn = await fetch(link, { redirect: 'manual' });
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0];
    if (signIn.status !== 302 || !cookie)
      return [`shardlens dashboard: its link answered ${signIn.status}, no session`];
    const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json();
    if (me.method !== 'link') failures.push(`shardlens dashboard: signed in as ${me.method}, not with the link`);
    const settings = await fetch(`${base}/v1/settings`, { headers: { cookie } });
    if (settings.status !== 200) failures.push(`shardlens dashboard: Settings answered ${settings.status}`);
    const runs = (read) => JSON.stringify(read.rows.map((row) => [row.command, row.runs]).sort());
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-shardlens-csrf': '1' },
      body: JSON.stringify({ range, kind: 'commands' }),
    });
    if (!res.ok) failures.push(`shardlens dashboard: a query answered ${res.status}`);
    else if (runs(await res.json()) !== runs(await query({ kind: 'commands' }))) {
      failures.push('shardlens dashboard read other runs per command than the collector image');
    }
    const again = await fetch(link, { redirect: 'manual' });
    if (again.headers.get('location') !== '/?error=link_expired') failures.push('the sign-in link worked twice');
  } finally {
    cli.kill('SIGINT');
    const exit = await Promise.race([cli.closed, sleep(15_000, 'timeout')]);
    if (exit !== 0) failures.push(`shardlens dashboard exited with ${exit} after Ctrl+C`);
  }
  return failures;
}

/**
 * Runs `bot`, installed in `dir`. Resolves with what failed, how many events were sent, and the secrets and
 * identities the leak check must not find.
 */
export async function drive(bot, { dir, logs, databases, collectorMain, panel, cliMain }) {
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
  const mongoUrl = config.mongodb && mongoDatabaseUrl(databases.mongo, config.mongodb.database);
  const standalone = config.embedded
    ? undefined
    : config.mongodb
      ? {
          // The collector image on the bot's own database: no secrets of its own, a read key to sign in with.
          url: collectorUrl,
          readKey: `slk_read_${randomBytes(32).toString('base64url')}`,
          env: {
            ...process.env,
            DATABASE_URL: mongoUrl,
            SHARDLENS_PUBLIC_URL: collectorUrl,
            SHARDLENS_APP_ID: appId,
            PORT: String(config.collectorPort),
            HOST: '127.0.0.1',
            LOG_LEVEL: 'info',
          },
        }
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
      env: { ...env, ...(ingestKey ? { SHARDLENS_INGEST_KEY: ingestKey } : {}), SHARDLENS_READ_KEY: readKey },
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
      ...(config.mongodb ? { [config.mongodb.env]: mongoUrl } : {}),
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
      // On MongoDB the outage is the database's: the collector inside the bot loses it.
      if (config.mongodb) stopDatabase('mongo');
      else {
        collector.kill('SIGTERM');
        await collector.closed;
      }
      await sim('/_sim/continue', { method: 'POST' });
    } else if (status.phase === 'paused:start-collector') {
      // Long enough that the SDK's sends fail and back off.
      await sleep(8_000);
      if (config.mongodb) await restartDatabase('mongo');
      else await startCollector();
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
    if (mismatches.length === 0) {
      failures.push(...(await panelMismatches({ panel, url: collectorUrl, readKey, range, appId, query })));
      if (config.mongodb) {
        failures.push(
          ...(await dashboardCommand({
            cliMain,
            dir,
            mongodb: config.mongodb,
            mongoUrl,
            port: config.dashboardPort,
            log: log('dashboard'),
            range,
            query,
          })),
        );
      }
    }
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
