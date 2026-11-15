// Runs last (files run in name order with one worker): it switches the shared collector into audit mode and back.
import { expect, expectAccessible, test } from './fixtures';

test('audit mode: switch on, view the activity log, export with confirmation, switch off', async ({ admin: page }) => {
  await page.goto('/settings');
  const dataMode = page.locator('form', { has: page.getByLabel('Mode') });
  await dataMode.getByLabel('Mode').selectOption('audit');

  // Turning audit mode on asks first; cancelling changes nothing.
  page.once('dialog', (dialog) => void dialog.dismiss());
  await dataMode.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toHaveCount(0);

  page.once('dialog', (dialog) => void dialog.accept());
  await dataMode.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Audit mode is on.')).toBeVisible();

  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  await page.getByRole('group', { name: 'Top users over' }).getByRole('button', { name: '7 days' }).click();
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  await expectAccessible(page);

  // An ID the collector would refuse is caught in the form, not shown as a failed load.
  await page.getByLabel('Server ID').fill('not-an-id');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'A server ID is 17 to 19 digits.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Server ID').fill('');

  // On a phone the log has the full width, with the top users under it instead of beside it.
  await page.setViewportSize({ width: 375, height: 812 });
  const logPanel = await page.getByRole('region', { name: 'Activity log' }).boundingBox();
  expect(logPanel?.width).toBeGreaterThan(300);
  await page.setViewportSize({ width: 1280, height: 720 });

  const unconfirmed = await page.request.get('/v1/audit/export.csv', { headers: { 'x-shardlens-csrf': '1' } });
  expect(unconfirmed.status()).toBe(428);
  const exported = await page.request.get('/v1/audit/export.csv', {
    headers: { 'x-shardlens-csrf': '1', 'x-shardlens-confirm': 'export-audit-log' },
  });
  expect(exported.status()).toBe(200);
  expect(exported.headers()['content-type']).toContain('text/csv');

  // Every view and export is in the access log.
  const log = await page.request.get('/v1/audit/access-log');
  expect(JSON.stringify(await log.json())).toContain('export');

  await page.goto('/settings');
  await dataMode.getByLabel('Mode').selectOption('privacy');
  await dataMode.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Audit mode is on.')).toHaveCount(0);
});
