import { type Page, test as plain } from '@playwright/test';
import { READ_KEY, XSS_NAME } from './env';
import { expect, expectAccessible, test } from './fixtures';

const PAGES = [
  { path: '/', heading: 'Overview' },
  { path: '/commands', heading: 'Commands' },
  { path: '/commands/ticket', heading: undefined },
  { path: '/servers', heading: 'Servers' },
  { path: '/growth', heading: 'Growth' },
  { path: '/audience', heading: 'Audience' },
  { path: '/time', heading: 'Time patterns' },
  { path: '/reliability', heading: 'Reliability' },
  { path: '/premium', heading: 'Premium' },
  { path: '/events', heading: 'Custom events' },
] as const;

async function settled(page: Page, heading?: string) {
  await expect(heading ? page.getByRole('heading', { level: 1, name: heading }) : page.locator('h1')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
}

plain('signing in with a read key opens the dashboard', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Read key').fill(READ_KEY);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

plain('a wrong read key is refused', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Read key').fill(`slk_read_${'Z'.repeat(43)}`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That read key was not accepted.');
});

for (const { path, heading } of PAGES) {
  test(`${path} renders with seeded data and passes axe`, async ({ reader: page }) => {
    await page.goto(path);
    await settled(page, heading);
    await expectAccessible(page);
  });
}

test('the dark theme passes axe too', async ({ reader: page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const { path, heading } of PAGES.filter((p) => ['/', '/commands', '/reliability'].includes(p.path))) {
    await page.goto(path);
    await settled(page, heading);
    await expectAccessible(page);
  }
});

test('live updates do not redraw the overview chart', async ({ reader: page }) => {
  await page.goto('/');
  await settled(page, 'Overview');
  await expect(page.getByRole('img', { name: 'Live' }).first()).toBeVisible();
  await page.locator('.chart canvas').evaluate((canvas) => canvas.setAttribute('data-e2e', 'first-draw'));
  // Live tiles arrive every second and re-render the page around the chart.
  await page.waitForTimeout(2_500);
  await expect(page.locator('.chart canvas[data-e2e="first-draw"]')).toHaveCount(1);
});

test('the theme choice is remembered', async ({ reader: page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Theme: system' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('choice buttons are labelled groups', async ({ reader: page }) => {
  await page.goto('/events');
  await settled(page, 'Custom events');
  await expect(page.getByRole('group', { name: 'Time range' })).toBeVisible();
  const size = page.getByRole('group', { name: 'Cohort size' });
  await size.getByRole('button', { name: 'Daily' }).click();
  await expect(size.getByRole('button', { name: 'Daily' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('columnheader', { name: 'Day 1', exact: true })).toBeVisible();
});

test('server names render as text, never as markup', async ({ reader: page }) => {
  await page.goto('/servers');
  await settled(page, 'Servers');
  const cell = page.getByText(XSS_NAME, { exact: true });
  await expect(cell).toBeVisible();
  await cell.click();
  await expect(page.locator('h1')).toHaveText(XSS_NAME);
  await settled(page);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.locator('main b', { hasText: 'Server' })).toHaveCount(0);
});

test('every page is served with a strict Content Security Policy', async ({ request }) => {
  for (const path of ['/', '/servers', '/settings']) {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const csp = res.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
  }
});

test('a read key can view but not change settings', async ({ reader: page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Sign in with Discord to continue')).toBeVisible();
  const res = await page.request.put('/v1/settings', {
    data: { timezone: 'UTC' },
    headers: { 'x-shardlens-csrf': '1' },
  });
  expect(res.status()).toBe(403);
});

test('an unknown address says so instead of showing an empty page', async ({ reader: page }) => {
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the overview' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('wide tables scroll inside their panel on a phone, not the whole page', async ({ reader: page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ['/commands', '/servers', '/reliability']) {
    await page.goto(path);
    await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});
