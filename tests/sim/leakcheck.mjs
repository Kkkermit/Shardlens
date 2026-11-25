// Searches everything a simulated install stored or logged for what must never be there: raw user IDs, usernames,
// display names, avatars, the bot token, interaction tokens and text users typed.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { BOTS } from './bots.mjs';
import { copyRows, dump, dumpShardlens, MONGO_PASSWORD } from './databases.mjs';

const asText = (rows) =>
  JSON.stringify(rows, (_k, v) =>
    typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
  );

/** The embedded collector's database, with the PGlite the bot installed. The bot must have stopped. */
async function dumpPglite(botDir, dataDir) {
  const { PGlite } = await import(
    pathToFileURL(createRequire(join(botDir, 'package.json')).resolve('@electric-sql/pglite')).href
  );
  const pg = await PGlite.create({ dataDir: join(botDir, dataDir, 'db') });
  try {
    const tables = await pg.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    let out = '';
    for (const { table_name } of tables.rows) {
      out += `${table_name} ${asText((await pg.query(`SELECT * FROM "${table_name}"`)).rows)}\n`;
    }
    return out;
  } finally {
    await pg.close();
  }
}

function dumpSqlite(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    return {
      text: tables.map(({ name }) => `${name} ${asText(db.prepare(`SELECT * FROM "${name}"`).all())}`).join('\n'),
      rows: db.prepare('SELECT count(*) AS n FROM shardlens_events').get().n,
    };
  } finally {
    db.close();
  }
}

/** Resolves with what was found where, how much was searched, and how many events the install's copy holds. */
export async function leakCheck(bot, { dir, logs, needles: { token, users, interactionTokens } }) {
  const { embedded, copy, mongodb } = BOTS[bot];
  const needles = [
    ['the bot token', token],
    ['the MongoDB password', MONGO_PASSWORD],
    ...users.flatMap((u) => [
      [`the user ID of ${u.username}`, u.id],
      [`the username ${u.username}`, u.username],
      [`the display name of ${u.username}`, u.global_name],
      [`the avatar of ${u.username}`, u.avatar],
    ]),
    ...interactionTokens.map((t, i) => [`interaction token ${i + 1}`, t]),
    ['typed text', 'secret plan'],
    ['typed text', 'card 4111'],
  ];

  const sources = { 'the bot log': readFileSync(join(logs, `${bot}-bot.log`), 'utf8') };
  if (embedded) {
    sources['the collector database'] = await dumpPglite(dir, embedded.dir);
  } else {
    sources['the collector log'] = readFileSync(join(logs, `${bot}-collector.log`), 'utf8');
    // On MongoDB, what Shardlens keeps beside the bot's own collections (which may hold user IDs of the bot's own).
    sources['the collector database'] = mongodb ? dumpShardlens(mongodb.database) : dump('postgres', 'shardlens');
  }
  const dashboardLog = join(logs, `${bot}-dashboard.log`);
  if (existsSync(dashboardLog)) sources['the shardlens dashboard log'] = readFileSync(dashboardLog, 'utf8');
  let rows;
  if (!copy) {
    rows = undefined;
  } else if (copy.sqlite) {
    ({ text: sources['the copy'], rows } = dumpSqlite(join(dir, copy.sqlite)));
  } else {
    const [db, database] = Object.entries(copy)[0];
    sources['the copy'] = dump(db, database);
    rows = copyRows(db, database);
  }

  const found = [];
  for (const [where, text] of Object.entries(sources)) {
    for (const [what, needle] of needles) if (needle && text.includes(needle)) found.push(`${what} in ${where}`);
  }
  const chars = Object.values(sources).reduce((n, text) => n + text.length, 0);
  return { found, needles: needles.length, chars, rows };
}
