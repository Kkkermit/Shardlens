// Emits JSON artefacts next to the build: the batch JSON Schema (what an SDK may send) and the
// metric and data-collected registers the docs site renders. Runs after tsdown.
import { writeFile } from 'node:fs/promises';
import { batchJsonSchema, COLLECTED_FIELDS, METRICS, RETENTION } from '../dist/index.js';

const dist = new URL('../dist/', import.meta.url);

const write = (name, value) => writeFile(new URL(name, dist), `${JSON.stringify(value, null, 2)}\n`);

await Promise.all([
  write('batch.schema.json', batchJsonSchema()),
  write('metrics.json', METRICS),
  write('collected-fields.json', { retention: RETENTION, fields: COLLECTED_FIELDS }),
]);
