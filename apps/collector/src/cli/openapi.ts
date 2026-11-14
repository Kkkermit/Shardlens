// Writes the collector's OpenAPI document (for the docs site):  node dist/cli/openapi.js <file>
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openApiDocument } from '../openapi.js';

const out = process.argv[2];
const doc = `${JSON.stringify(openApiDocument(), null, 2)}\n`;
if (out) {
  // The docs site's generated/ folder is not in git, so on a fresh checkout it doesn't exist yet.
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, doc);
} else process.stdout.write(doc);
