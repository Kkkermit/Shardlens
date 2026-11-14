// Writes the collector's OpenAPI document (for the docs site):  node dist/cli/openapi.js <file>
import { writeFile } from 'node:fs/promises';
import { openApiDocument } from '../openapi.js';

const out = process.argv[2];
const doc = `${JSON.stringify(openApiDocument(), null, 2)}\n`;
if (out) await writeFile(out, doc);
else process.stdout.write(doc);
