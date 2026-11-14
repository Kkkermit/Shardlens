// Copies the built dashboard into public/, so the published package (embedded mode) serves it like the Docker image.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../dashboard/dist/', import.meta.url));
const target = fileURLToPath(new URL('../public/', import.meta.url));

if (!existsSync(`${source}index.html`)) {
  console.warn('copy-dashboard: apps/dashboard/dist not built; the collector will serve the API only.');
} else {
  rmSync(target, { recursive: true, force: true });
  // Source maps stay out of the package.
  cpSync(source, target, { recursive: true, filter: (path) => !path.endsWith('.map') });
  console.log('copy-dashboard: dashboard copied to public/');
}
