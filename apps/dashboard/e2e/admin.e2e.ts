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

  const enabled = page.getByRole('row', { name: /Morning summary/ }).getByRole('checkbox', { name: 'Enabled' });
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
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

  await page.getByLabel('Name').fill('Missed deadlines');
  await page.getByLabel('Discord webhook URL').fill('https://discord.com/api/webhooks/112233445566778899/e2e-token');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Alert created.' })).toBeVisible();
  const enabled = page.getByRole('row', { name: /Missed deadlines/ }).getByRole('checkbox', { name: 'Enabled' });
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expectAccessible(page);

  // Every action says how it went, next to the table.
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('row', { name: /Missed deadlines/ })
    .getByRole('button', { name: 'Delete' })
    .click();
  const rules = page.getByRole('region', { name: 'Rules' });
  await expect(rules.getByRole('status')).toHaveText(/Missed deadlines.* deleted\./);
  await expect(page.getByRole('row', { name: /Missed deadlines/ })).toHaveCount(0);
});

test('a SKU price is saved and removed, with the result beside its form', async ({ admin: page }) => {
  await page.goto('/settings');
  const prices = page.getByRole('region', { name: 'SKU prices' });
  await prices.getByRole('textbox', { name: 'SKU ID' }).fill('1180000000000000001');
  await prices.getByRole('spinbutton', { name: 'Price' }).fill('4.99');
  await prices.getByRole('textbox', { name: 'Currency' }).fill('eur');
  await prices.getByRole('button', { name: 'Save price' }).click();
  // In the panel that was used, and on screen: the top of this long page is out of view from here.
  const saved = prices.getByRole('status').getByText('Saved.');
  await expect(saved).toBeInViewport();
  await expect(prices.getByRole('row', { name: /1180000000000000001/ })).toContainText('4,99');
  await expect(prices.getByRole('textbox', { name: 'SKU ID' })).toHaveValue('');

  await prices.getByRole('textbox', { name: 'SKU ID' }).fill('12');
  await prices.getByRole('spinbutton', { name: 'Price' }).fill('1');
  await prices.getByRole('textbox', { name: 'Currency' }).fill('USD');
  await prices.getByRole('button', { name: 'Save price' }).click();
  await expect(prices.getByRole('status')).toContainText('Enter the SKU ID');

  await prices.getByRole('button', { name: 'Remove' }).click();
  await expect(prices.getByText('No prices yet.')).toBeVisible();
});

test('a key is shown once when created, and revoking it says so', async ({ admin: page }) => {
  await page.goto('/settings');
  const keys = page.getByRole('region', { name: 'API keys' });
  page.once('dialog', (dialog) => void dialog.accept('e2e scripts'));
  await keys.getByRole('button', { name: 'New read key' }).click();
  await expect(keys.getByText(/Copy this key now.*slk_read_/)).toBeVisible();
  const row = keys.getByRole('row', { name: /e2e scripts/ });
  await expect(row).toContainText('Active');

  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(keys.getByRole('status').filter({ hasText: 'is revoked.' })).toContainText('e2e scripts');
  await expect(row).toContainText('Revoked');
  // A key that no longer works isn't left on screen to be copied.
  await expect(keys.getByText('Copy this key now')).toHaveCount(0);
});

test('a permission value the collector would refuse is caught in the form', async ({ admin: page }) => {
  await page.goto('/settings');
  const permissions = page.getByRole('region', { name: 'Permission health' });
  await permissions.getByLabel('Required permission bits (decimal)').fill('99999999999999999999');
  await permissions.getByRole('button', { name: 'Save' }).click();
  await expect(permissions.getByRole('status')).toContainText('Enter the permission bits as one whole number');
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
