// The databases the bots use, in throwaway Docker containers, published on 127.0.0.1 only. PostgreSQL and MySQL each
// hold a database named `shardlens`.
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PASSWORD = 'sim';
/** Shaped like an Atlas password, so the leak check finds a connection string that was logged. */
export const MONGO_PASSWORD = 'Mn9vQe2LsimPw7x';
// Container names start with this, so two runs on one machine (with their own SIM_PORTS) don't remove each other's.
const PREFIX = process.env.SIM_CONTAINERS ?? 'shardlens-sim';

function mongoAuth() {
  return ['-u', 'sim', '-p', MONGO_PASSWORD, '--authenticationDatabase', 'admin'];
}

/** A connection string for one database on the sim's MongoDB, from `startDatabases`'s base URL. */
export const mongoDatabaseUrl = (base, database) => `${base}/${database}?authSource=admin`;

const CONTAINERS = {
  postgres: {
    name: `${PREFIX}-postgres`,
    image: 'postgres:17-alpine',
    port: 5432,
    env: { POSTGRES_USER: 'shardlens', POSTGRES_PASSWORD: PASSWORD, POSTGRES_DB: 'shardlens' },
    // Over TCP: while it initialises, the image runs a temporary server on the socket only.
    ready: ['pg_isready', '-h', '127.0.0.1', '-U', 'shardlens'],
    url: (port) => `postgres://shardlens:${PASSWORD}@127.0.0.1:${port}`,
  },
  mysql: {
    name: `${PREFIX}-mysql`,
    image: 'mysql:8.4',
    port: 3306,
    env: { MYSQL_ROOT_PASSWORD: PASSWORD, MYSQL_DATABASE: 'shardlens' },
    // Same here: the temporary server skips networking.
    ready: ['mysql', '-h127.0.0.1', '-uroot', '-e', 'SELECT 1'],
    url: (port) => `mysql://root:${PASSWORD}@127.0.0.1:${port}`,
  },
  // With a user, like Atlas: a connection string always holds a password that must never be logged or stored.
  mongo: {
    name: `${PREFIX}-mongo`,
    image: 'mongo:8.0',
    port: 27017,
    env: { MONGO_INITDB_ROOT_USERNAME: 'sim', MONGO_INITDB_ROOT_PASSWORD: MONGO_PASSWORD },
    ready: ['mongosh', '--quiet', ...mongoAuth(), '--eval', 'db.runCommand({ ping: 1 }).ok'],
    url: (port) => `mongodb://sim:${MONGO_PASSWORD}@127.0.0.1:${port}`,
  },
};

const docker = (args) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function exec(db, args) {
  const r = docker(['exec', '-e', `MYSQL_PWD=${PASSWORD}`, CONTAINERS[db].name, ...args]);
  if (r.status !== 0) throw new Error(`${args[0]} in ${CONTAINERS[db].name} failed: ${r.error ?? r.stderr}`);
  return r.stdout;
}

/** Starts the named databases on the given host ports; resolves with their URLs (no database name) once ready. */
export async function startDatabases(names, ports) {
  removeDatabases();
  for (const name of names) {
    const { name: container, image, port, env } = CONTAINERS[name];
    const vars = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const r = docker(['run', '-d', '--name', container, '-p', `127.0.0.1:${ports[name]}:${port}`, ...vars, image]);
    if (r.status !== 0) throw new Error(`docker run ${image} failed: ${r.error ?? r.stderr}`);
  }
  for (const name of names) await ready(name);
  return Object.fromEntries(names.map((name) => [name, CONTAINERS[name].url(ports[name])]));
}

async function ready(name) {
  const until = Date.now() + 180_000;
  while (docker(['exec', '-e', `MYSQL_PWD=${PASSWORD}`, CONTAINERS[name].name, ...CONTAINERS[name].ready]).status) {
    if (Date.now() > until) throw new Error(`${CONTAINERS[name].name} did not become ready`);
    await sleep(1_000);
  }
}

/** A database outage: stops the container, keeping its data, as a restart or a network cut would. */
export function stopDatabase(name) {
  const r = docker(['stop', '-t', '5', CONTAINERS[name].name]);
  if (r.status !== 0) throw new Error(`docker stop ${CONTAINERS[name].name} failed: ${r.error ?? r.stderr}`);
}

/** Ends the outage: starts the container again and resolves once it answers. */
export async function restartDatabase(name) {
  const r = docker(['start', CONTAINERS[name].name]);
  if (r.status !== 0) throw new Error(`docker start ${CONTAINERS[name].name} failed: ${r.error ?? r.stderr}`);
  await ready(name);
}

/** Removes the sim's containers (only those, by exact name) and their volumes. Missing ones are fine. */
export function removeDatabases() {
  docker(['rm', '-f', '-v', ...Object.values(CONTAINERS).map((c) => c.name)]);
}

export const mongosh = (database, script) =>
  exec('mongo', ['mongosh', '--quiet', ...mongoAuth(), database, '--eval', script]);

/** Everything a database holds, as text. */
export function dump(db, database) {
  if (db === 'postgres') return exec('postgres', ['pg_dump', '-U', 'shardlens', database]);
  if (db === 'mysql') return exec('mysql', ['mysqldump', '-uroot', '--no-tablespaces', database]);
  return mongosh(database, 'db.getCollectionNames().forEach((c) => print(c, EJSON.stringify(db[c].find().toArray())))');
}

/** What Shardlens keeps in a bot's own MongoDB (its `shardlens_` collections), as text: not the bot's own data. */
export function dumpShardlens(database) {
  return mongosh(
    database,
    "db.getCollectionNames().filter((c) => c.startsWith('shardlens_')).forEach((c) => print(c, EJSON.stringify(db[c].find().toArray())))",
  );
}

/** The names of the collections in a database. */
export function collections(database) {
  return mongosh(database, 'print(db.getCollectionNames().join(" "))').trim().split(/\s+/).filter(Boolean);
}

/** Events in a copy (the event sink's default table or collection). */
export function copyRows(db, database) {
  const out =
    db === 'mysql'
      ? exec('mysql', ['mysql', '-uroot', '-N', '-e', 'SELECT count(*) FROM shardlens_events', database])
      : mongosh(database, 'print(db.shardlens_events.countDocuments())');
  return Number(out.trim());
}
