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

  // A server's page leads to its failed runs: the log opens narrowed to them, and asks the collector for them.
  await page.goto('/servers');
  await page.getByRole('group', { name: 'Servers' }).getByRole('link').first().click();
  const asked = page.waitForRequest((req) => /\/v1\/audit\/log\?.*outcome=failed/.test(req.url()));
  await page.getByRole('region', { name: 'Failing commands' }).getByRole('link', { name: 'View failed runs' }).click();
  await expect(page).toHaveURL(/\/activity\?guild=\d{17,19}&outcome=failed$/);
  const server = new URL(page.url()).searchParams.get('guild');
  expect(new URL((await asked).url()).searchParams.get('guild')).toBe(server);
  await expect(page.getByLabel('Outcome')).toHaveValue('failed');
  await expect(page.getByLabel('Server ID')).toHaveValue(server ?? '');
  await expectAccessible(page);

  await page.goto('/commands/ticket');
  await expect(
    page.getByRole('region', { name: 'Outcomes' }).getByRole('link', { name: 'View failed runs' }),
  ).toHaveAttribute('href', '/activity?command=ticket&outcome=failed');

  // A link written by hand keeps a long ID digit for digit; the form's changes go to the address, a user ID never.
  await page.goto('/activity?guild=123456789012345678&command=ticket&outcome=timeout');
  await expect(page.getByLabel('Server ID')).toHaveValue('123456789012345678');
  await expect(page.getByLabel('Command', { exact: true })).toHaveValue('ticket');
  await expect(page.getByLabel('Outcome')).toHaveValue('timeout');
  await page.getByLabel('Outcome').selectOption('');
  await page.getByLabel('Exact user ID').fill('80351110224678912');
  const lookup = page.waitForRequest((req) => req.url().includes('user=80351110224678912'));
  await page.getByRole('button', { name: 'Apply' }).click();
  expect((await lookup).url()).not.toContain('outcome=');
  await expect(page).toHaveURL(/\/activity\?command=ticket&guild=123456789012345678$/);

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
