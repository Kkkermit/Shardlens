import { expect, expectAccessible, test } from './fixtures';

test('settings render for the app owner and pass axe', async ({ admin: page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  await expectAccessible(page);
});

test('a setting can be saved', async ({ admin: page }) => {
  await page.goto('/settings');
  const general = page.locator('form', { has: page.getByLabel('Time zone') });
  await general.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.').first()).toBeVisible();
});

test('a report can be scheduled, and only to a Discord webhook', async ({ admin: page }) => {
  await page.goto('/reports');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  await expectAccessible(page);

  await page.getByLabel('Name').fill('Morning summary');
  await page.getByLabel('How often').selectOption('weekly');
  await page.getByLabel('Day').selectOption('Friday');
  const refused = await page.request.post('/v1/reports', {
    data: { name: 'SSRF attempt', schedule: 'daily', hour: 9, webhookUrl: 'https://example.com/not-discord' },
    headers: { 'x-shardlens-csrf': '1' },
  });
  expect(refused.status()).toBe(400);

  await page.getByLabel('Discord webhook URL').fill('https://discord.com/api/webhooks/112233445566778899/e2e-token');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('cell', { name: 'Every Friday at 09:00' })).toBeVisible();
  await expect(page.getByText('e2e-token')).toHaveCount(0);
  await expectAccessible(page);
});

test('alerts render and refuse non-Discord webhooks', async ({ admin: page }) => {
  await page.goto('/alerts');
  await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  await expectAccessible(page);
  const res = await page.request.post('/v1/alerts', {
    data: {
      name: 'SSRF attempt',
      metric: 'error_rate',
      comparator: '>',
      threshold: 1,
      windowS: 600,
      webhookUrl: 'http://169.254.169.254/latest/meta-data',
    },
    headers: { 'x-shardlens-csrf': '1' },
  });
  expect(res.status()).toBe(400);
});

test('settings fit a phone screen without sideways scrolling', async ({ admin: page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/settings');
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
