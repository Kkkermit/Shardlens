import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'node22',
  // Runs on Node, Bun, Deno and Workers: no Node built-ins.
  platform: 'neutral',
  // Off: a published file pointing at a map the tarball doesn't hold makes consumers' bundlers warn.
  sourcemap: false,
  clean: true,
});
