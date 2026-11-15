// The databases the bots use, in throwaway Docker containers with fixed names, published on 127.0.0.1 only.
// PostgreSQL and MySQL each hold a database named `shardlens`.
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PASSWORD = 'sim';

const CONTAINERS = {
  postgres: {
    name: 'shardlens-sim-postgres',
    image: 'postgres:17-alpine',
    port: 5432,
    env: { POSTGRES_USER: 'shardlens', POSTGRES_PASSWORD: PASSWORD, POSTGRES_DB: 'shardlens' },
    // Over TCP: while it initialises, the image runs a temporary server on the socket only.
    ready: ['pg_isready', '-h', '127.0.0.1', '-U', 'shardlens'],
    url: (port) => `postgres://shardlens:${PASSWORD}@127.0.0.1:${port}`,
  },
  mysql: {
    name: 'shardlens-sim-mysql',
    image: 'mysql:8.4',
    port: 3306,
    env: { MYSQL_ROOT_PASSWORD: PASSWORD, MYSQL_DATABASE: 'shardlens' },
    // Same here: the temporary server skips networking.
    ready: ['mysql', '-h127.0.0.1', '-uroot', '-e', 'SELECT 1'],
    url: (port) => `mysql://root:${PASSWORD}@127.0.0.1:${port}`,
  },
  mongo: {
    name: 'shardlens-sim-mongo',
    image: 'mongo:8.0',
    port: 27017,
    env: {},
    ready: ['mongosh', '--quiet', '--eval', 'db.runCommand({ ping: 1 }).ok'],
    url: (port) => `mongodb://127.0.0.1:${port}`,
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
  for (const name of names) {
    const until = Date.now() + 180_000;
    while (docker(['exec', '-e', `MYSQL_PWD=${PASSWORD}`, CONTAINERS[name].name, ...CONTAINERS[name].ready]).status) {
      if (Date.now() > until) throw new Error(`${CONTAINERS[name].name} did not become ready`);
      await sleep(1_000);
    }
  }
  return Object.fromEntries(names.map((name) => [name, CONTAINERS[name].url(ports[name])]));
}

/** Removes the sim's containers (only those, by exact name) and their volumes. Missing ones are fine. */
export function removeDatabases() {
  docker(['rm', '-f', '-v', ...Object.values(CONTAINERS).map((c) => c.name)]);
}

export const mongosh = (database, script) => exec('mongo', ['mongosh', '--quiet', database, '--eval', script]);

/** Everything a database holds, as text. */
export function dump(db, database) {
  if (db === 'postgres') return exec('postgres', ['pg_dump', '-U', 'shardlens', database]);
  if (db === 'mysql') return exec('mysql', ['mysqldump', '-uroot', '--no-tablespaces', database]);
  return mongosh(database, 'db.getCollectionNames().forEach((c) => print(c, EJSON.stringify(db[c].find().toArray())))');
}

/** Events in a copy (the event sink's default table or collection). */
export function copyRows(db, database) {
  const out =
    db === 'mysql'
      ? exec('mysql', ['mysql', '-uroot', '-N', '-e', 'SELECT count(*) FROM shardlens_events', database])
      : mongosh(database, 'print(db.shardlens_events.countDocuments())');
  return Number(out.trim());
}
