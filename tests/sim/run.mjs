// `pnpm sim [bot…]`: Shardlens installed the way bot owners get it. Packs the workspace's published packages,
// installs them with npm into three bots that coding agents set up (bots/), starts the databases those use in Docker,
// runs each bot against a fake Discord, checks every count against what was sent and searches everything the install
// stored or logged for leaks. Exits non-zero on any failure. Needs Docker; see README.md.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOTS, DATABASE_PORTS } from './bots.mjs';
import { removeDatabases, startDatabases } from './databases.mjs';
import { drive } from './drive.mjs';
import { install, packWorkspace } from './install.mjs';
import { leakCheck } from './leakcheck.mjs';
import { stopAll } from './processes.mjs';

const bots = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(BOTS);
const unknown = bots.filter((bot) => !BOTS[bot]);
if (unknown.length > 0) {
  console.error(`Unknown bot ${unknown.join(', ')}. The bots are ${Object.keys(BOTS).join(', ')}.`);
  process.exit(2);
}

const started = Date.now();
const elapsed = (since) => {
  const s = Math.round((Date.now() - since) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const step = (what) => console.log(`[${elapsed(started)}] ${what}`);

const work = mkdtempSync(join(tmpdir(), 'shardlens-sim-'));
const logs = join(work, 'logs');
mkdirSync(logs);
const setupLog = join(logs, 'setup.log');
let passed = false;

// Logs are kept when the run fails.
function cleanUp() {
  stopAll();
  removeDatabases();
  if (passed) rmSync(work, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanUp();
    console.log(`Logs: ${logs}`);
    process.exit(130);
  });
}

const results = [];
try {
  step('building and packing the published packages');
  const packages = packWorkspace(join(work, 'packages'), setupLog);

  step(`installing ${bots.join(', ')} with npm`);
  for (const bot of bots) {
    cpSync(join(import.meta.dirname, 'bots', bot), join(work, 'bots', bot), { recursive: true });
    install(join(work, 'bots', bot), packages, setupLog);
  }
  const collectorDir = join(work, 'collector');
  if (bots.some((bot) => !BOTS[bot].embedded)) {
    mkdirSync(collectorDir);
    const manifest = { name: 'collector', private: true, dependencies: { '@shardlens/collector': '*' } };
    writeFileSync(join(collectorDir, 'package.json'), JSON.stringify(manifest));
    install(collectorDir, packages, setupLog);
  }

  const needed = [...new Set(bots.flatMap((bot) => BOTS[bot].databases))];
  let databases = {};
  if (needed.length > 0) {
    step(`starting ${needed.join(', ')} in Docker`);
    databases = await startDatabases(needed, DATABASE_PORTS);
  }

  for (const bot of bots) {
    step(`running ${bot}`);
    const since = Date.now();
    const dir = join(work, 'bots', bot);
    const result = { bot, failures: [] };
    try {
      const collectorMain = join(collectorDir, 'node_modules/@shardlens/collector/dist/main.js');
      const { failures, events, needles } = await drive(bot, { dir, logs, databases, collectorMain });
      const leaks = await leakCheck(bot, { dir, logs, needles });
      result.failures.push(...failures, ...leaks.found.map((leak) => `leak: ${leak}`));
      if (leaks.rows === 0) result.failures.push('the copy holds no events');
      result.summary =
        `${events} events sent, the copy holds ${leaks.rows}, ` +
        `${leaks.needles} secrets and identities searched for in ${Math.round(leaks.chars / 1024)} KiB`;
    } catch (error) {
      result.failures.push(error.message);
      stopAll();
    }
    result.time = elapsed(since);
    results.push(result);
  }
  passed = results.every((r) => r.failures.length === 0);
} catch (error) {
  console.error(error.message);
} finally {
  cleanUp();
}

console.log(`\nShardlens simulated installs: ${passed ? 'passed' : 'FAILED'} in ${elapsed(started)}`);
for (const { bot, failures, summary, time } of results) {
  console.log(`  ${bot.padEnd(10)} ${failures.length ? 'FAIL' : 'pass'}  ${summary ?? ''} (${time})`);
  for (const failure of failures) console.log(`      ${failure}`);
}
if (!passed) console.log(`Logs: ${logs}`);
process.exit(passed ? 0 : 1);
