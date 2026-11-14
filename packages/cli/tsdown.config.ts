import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  target: 'node22',
  platform: 'node',
  sourcemap: false,
  clean: true,
  fixedExtension: false,
  banner: { js: '#!/usr/bin/env node' },
});
