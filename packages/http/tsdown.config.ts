import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2023',
  // Runs on Cloudflare Workers, Deno, Bun and Node: Web-standard APIs only, no Node built-ins.
  platform: 'neutral',
  sourcemap: true,
  clean: true,
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
