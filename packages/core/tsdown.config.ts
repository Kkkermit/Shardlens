import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'node22',
  // Runs on Node, Bun, Deno and Workers: no Node built-ins.
  platform: 'neutral',
  sourcemap: true,
  clean: true,
});
