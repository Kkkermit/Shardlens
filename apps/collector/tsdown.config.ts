import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts', 'src/healthcheck.ts', 'src/cli/seed.ts', 'src/cli/openapi.ts', 'src/embedded.ts'],
  format: ['esm'],
  // Types for the public `./embedded` entry (the other entries are programs).
  dts: { entry: ['src/embedded.ts'] },
  target: 'node24',
  platform: 'node',
  sourcemap: true,
  clean: true,
  fixedExtension: false,
});
