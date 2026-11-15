import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'node22',
  platform: 'node',
  // The published files leave maps out, and a comment pointing at a missing map only produces warnings.
  sourcemap: false,
  clean: true,
  fixedExtension: false,
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
