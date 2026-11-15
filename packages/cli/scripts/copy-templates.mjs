// Copies the deployment files into dist/templates for `shardlens init`. Three things differ from the files in deploy/:
// the build-from-source block is dropped (it only makes sense inside this repository), the collector image is pinned
// to the release line this CLI ships with (a `:1` tag doesn't exist while versions are 0.x), and the header drops the
// `.env.example` step, because `init` writes the `.env` itself.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const deploy = new URL('../../../deploy/', import.meta.url);
const out = new URL('../dist/templates/', import.meta.url);
const collector = JSON.parse(await readFile(new URL('../../../apps/collector/package.json', import.meta.url), 'utf8'));
const [major, minor] = collector.version.split('.');
const tag = major === '0' ? `${major}.${minor}` : major;

const BUILD_BLOCK = /\n {4}# Until images are published[^\n]*\n {4}build:\n {6}context: \.\.\n {6}dockerfile: [^\n]+\n/;
const IMAGE = 'ghcr.io/kkkermit/shardlens-collector:1}';
const ENV_STEP = '#   cp .env.example .env   # then fill it in\n';
const source = await readFile(new URL('docker-compose.yml', deploy), 'utf8');
if (!BUILD_BLOCK.test(source) || !source.includes(IMAGE) || !source.includes(ENV_STEP)) {
  throw new Error('deploy/docker-compose.yml no longer has the lines this script rewrites: update copy-templates.mjs');
}

await mkdir(out, { recursive: true });
await writeFile(
  new URL('docker-compose.yml', out),
  source
    .replace(BUILD_BLOCK, '\n')
    .replace(IMAGE, `ghcr.io/kkkermit/shardlens-collector:${tag}}`)
    .replace(ENV_STEP, '#   Settings and secrets are in .env, next to this file (written by `shardlens init`).\n'),
);
await writeFile(new URL('Caddyfile', out), await readFile(new URL('Caddyfile', deploy), 'utf8'));
