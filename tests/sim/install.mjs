// Builds and packs the workspace's published packages, and installs them with npm the way a bot owner would, except
// that every Shardlens package comes from the packed tarballs instead of the registry.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');

function sh(log, command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  appendFileSync(log, `$ ${command} ${args.join(' ')} (in ${cwd})\n${r.stdout}${r.stderr}\n`);
  if (r.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${String(r.error ?? r.stderr).slice(-2000)}`);
  }
  return r.stdout;
}

/** Packs every published package into `dir`. Returns their npm specs (`file:…tgz`) by package name. */
export function packWorkspace(dir, log) {
  const packages = JSON.parse(sh(log, 'pnpm', ['ls', '-r', '--depth', '-1', '--json'], root)).filter((p) => !p.private);
  const filters = packages.map((p) => `--filter=${p.name}`);
  sh(log, 'pnpm', ['turbo', 'run', 'build', ...filters], root);
  const packed = JSON.parse(sh(log, 'pnpm', ['-r', ...filters, 'pack', '--pack-destination', dir, '--json'], root));
  return Object.fromEntries(packed.map((p) => [p.name, `file:${p.filename}`]));
}

/** Installs the npm project in `dir` against the packed `packages`, then builds it if it has a build script. */
export function install(dir, packages, log) {
  const file = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const name of Object.keys(deps ?? {})) if (packages[name]) deps[name] = packages[name];
  }
  // For the packages' dependencies on each other. An override of a direct dependency must match it exactly.
  pkg.overrides = packages;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  // Nothing published in the last day, like pnpm's minimumReleaseAge default for this repository.
  sh(log, 'npm', ['install', '--no-audit', '--no-fund', '--min-release-age=1'], dir);
  if (pkg.scripts?.build) sh(log, 'npm', ['run', 'build'], dir);
}
