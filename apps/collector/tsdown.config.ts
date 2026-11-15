import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts', 'src/healthcheck.ts', 'src/cli/seed.ts', 'src/cli/openapi.ts', 'src/embedded.ts'],
  format: ['esm'],
  // Types for the public `./embedded` entry (the other entries are programs).
  dts: { entry: ['src/embedded.ts'] },
  target: 'node24',
  platform: 'node',
  // The package and the image ship without source maps, so the code carries no comment pointing at one.
  sourcemap: false,
  clean: true,
  fixedExtension: false,
});
