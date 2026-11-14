import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './e2e/env';

// End-to-end tests: a real collector (built from apps/collector) on Testcontainers PostgreSQL with seeded demo data,
// serving this dashboard's production build. Needs Docker. Run with: pnpm --filter @shardlens/dashboard test:e2e
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  // One shared collector and database; the audit-mode spec switches the data mode, so run files in order.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
