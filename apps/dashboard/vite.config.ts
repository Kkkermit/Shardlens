import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard runs on Vite and proxies the API to a local collector.
const collector = process.env.SHARDLENS_COLLECTOR_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': collector, '/auth': collector },
  },
  build: {
    outDir: 'dist',
    // The collector ships this build without source maps, so the bundle must not point at one (it would 404).
    sourcemap: false,
    // No inline scripts or styles: the collector serves a strict CSP (script-src 'self'; style-src 'self').
    assetsInlineLimit: 0,
  },
});
