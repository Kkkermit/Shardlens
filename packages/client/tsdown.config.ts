import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2023',
  // Runs on Node, Bun, Deno, Cloudflare Workers and in Next.js route handlers: Web-standard APIs only.
  platform: 'neutral',
  // Off: a published file pointing at a map the tarball doesn't hold makes consumers' bundlers warn.
  sourcemap: false,
  clean: true,
});
