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
    // Each page names itself in the tab (WCAG 2.4.2).
    await expect(page).toHaveTitle(`${heading ?? '/ticket'} · Shardlens`);
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

test('signing out returns to the sign-in page without a failed request', async ({ page, pageErrors: _ }) => {
  await page.goto('/commands');
  await expect(page).toHaveTitle('Sign in · Shardlens');
  await page.getByLabel('Read key').fill(READ_KEY);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The page that was asked for, not the overview.
  await settled(page, 'Commands');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Read key')).toBeVisible();
  // Nothing asks the collector again with the session gone: the fixture fails the test on a 401 in the console.
  await page.waitForTimeout(500);
});

plain('a session ended elsewhere goes back to the sign-in page', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Read key').fill(READ_KEY);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  // As another tab signing out would: the session is gone, this page doesn't know yet.
  await page.request.post('/auth/logout', { data: {}, headers: { 'x-shardlens-csrf': '1' } });
  await page.getByRole('link', { name: 'Growth' }).click();
  await expect(page.getByLabel('Read key')).toBeVisible();
});

test('an unknown command says so, with the way back', async ({ reader: page }) => {
  for (const name of ['no-such-command', 'x'.repeat(40)]) {
    await page.goto(`/commands/${name}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Command not found' })).toBeVisible();
    await expect(page.getByText(`No command called ${name} is registered`)).toBeVisible();
    await expect(page.getByRole('group', { name: 'Time range' })).toHaveCount(0);
  }
  await page.getByRole('link', { name: 'All commands' }).click();
  await settled(page, 'Commands');

  // A registered command nobody has run yet is a command: its page says there are no runs.
  await page.goto('/commands/legacy-stats');
  await expect(page.getByRole('heading', { level: 1, name: '/legacy-stats' })).toBeVisible();
  await expect(page.getByText('No runs of /legacy-stats in this range.')).toBeVisible();
});

test('the server list keeps typing, sorting and paging in step with the address', async ({ reader: page }) => {
  await page.goto('/servers');
  await settled(page, 'Servers');
  const box = page.getByRole('searchbox');
  await box.pressSequentially(' Night');
  await expect(page).toHaveURL(/q=\+Night/);
  // Editing in the middle keeps the caret there, and a leading space stays while typing.
  await box.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
  await page.keyboard.type('xy');
  await expect(box).toHaveValue(' Nixyght');
  expect(await box.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(5);
  await box.fill('');
  await expect(page).not.toHaveURL(/q=/);

  // A text column sorts A to Z first; the header follows the address when it changes from elsewhere.
  await page.getByRole('button', { name: 'Server' }).click();
  await expect(page).toHaveURL(/sort=name&dir=asc/);
  await expect(page.getByRole('columnheader', { name: 'Server' })).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Servers' }).click();
  await expect(page.getByRole('columnheader', { name: 'Members' })).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByRole('columnheader', { name: 'Server' })).not.toHaveAttribute('aria-sort');

  // The last page's Next is unavailable, not disabled: the keyboard focus stays on it.
  const pager = page.getByRole('navigation', { name: 'Pages of the server list' });
  await pager.getByRole('button', { name: 'Next' }).click();
  await expect(pager.getByRole('status')).toHaveText('Page 2 of 2');
  await expect(pager.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
  await expect(pager.getByRole('button', { name: 'Next' })).toBeFocused();

  // A page past the end shows the last page.
  await page.goto('/servers?page=99');
  await expect(pager.getByRole('status')).toHaveText('Page 2 of 2');
  await expect(page.getByRole('group', { name: 'Servers' }).getByRole('row')).not.toHaveCount(1);
});

test('names stay readable in a table on a phone, and a long bot name stays in the sidebar', async ({
  reader: page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/servers');
  await settled(page, 'Servers');
  // Not one letter per line: the name column keeps a readable width and the table scrolls instead.
  const name = await page.getByText(XSS_NAME, { exact: true }).boundingBox();
  expect(name?.width).toBeGreaterThan(90);
  const brand = await page.locator('.brand').boundingBox();
  expect((brand?.x ?? 0) + (brand?.width ?? 0)).toBeLessThanOrEqual(375);
});

test('a failed answer is an error with a retry, never "no data"', async ({ reader: page, pageErrors }) => {
  let failing = true;
  await page.route('**/v1/query', (route) =>
    failing && route.request().postDataJSON()?.kind === 'overview'
      ? route.fulfill({ status: 500, json: { error: 'internal', requestId: 'req-e2e' } })
      : route.continue(),
  );
  await page.goto('/');
  const errors = page.getByRole('alert').filter({ hasText: "Couldn't load this. The collector ran into an error." });
  await expect(errors).toHaveCount(3);
  await expect(errors.first()).toContainText('req-e2e');
  await expect(page.getByText('No SDK has reported yet.')).toHaveCount(0);
  await expect(page.getByText('Waiting for the first events')).toHaveCount(0);
  await expect(page.getByText('No data in this range yet.')).toHaveCount(0);

  failing = false;
  await errors.first().getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.chart canvas')).toBeVisible();
  await expect(errors).toHaveCount(0);
  // The failed requests above are the point of this test.
  expect(pageErrors.every((e) => e.includes('500'))).toBe(true);
  pageErrors.length = 0;
});

test('the Overview notices a bot that starts after the page was opened', async ({ reader: page }) => {
  let first = true;
  await page.route('**/v1/query', async (route) => {
    if (!first || route.request().postDataJSON()?.kind !== 'overview') return route.continue();
    first = false;
    const response = await route.fetch();
    const body = (await response.json()) as { lastEventAt: string | null; checklist: Record<string, boolean> };
    await route.fulfill({
      response,
      json: { ...body, lastEventAt: null, checklist: { ...body.checklist, receivingEvents: false } },
    });
  });
  await page.goto('/');
  await expect(page.getByText('Waiting for the first events from your bot')).toBeVisible();
  // No reload: the page asks again by itself.
  await expect(page.getByText(/^Last event /)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Done: Receiving events from your bot')).toBeAttached();
});

test("a server's page shows the commands that fail there, and no way into who ran them", async ({ reader: page }) => {
  await page.goto('/servers');
  await settled(page, 'Servers');
  await page.getByRole('group', { name: 'Servers' }).getByRole('link').first().click();
  await settled(page);
  const failing = page.getByRole('region', { name: 'Failing commands' });
  // 30 days of seeded traffic in the largest server always include some failures.
  await expect(failing.getByRole('list', { name: 'Failing commands' }).getByRole('link').first()).toBeVisible();
  // Privacy mode, and a read key: there is no activity log to link to.
  await expect(page.getByRole('link', { name: 'View failed runs' })).toHaveCount(0);
  await expectAccessible(page);
});

test('navigating moves the focus to the new page, and rows open from the keyboard', async ({ reader: page }) => {
  await page.goto('/');
  await settled(page, 'Overview');
  await page.getByRole('link', { name: 'Commands' }).press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Commands' })).toBeFocused();
  await settled(page, 'Commands');
  await page.getByRole('link', { name: '/ticket' }).press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: '/ticket' })).toBeFocused();

  // Selecting an event is a button, with its state, not a click on a row.
  await page.goto('/events');
  await settled(page, 'Custom events');
  const event = page.getByRole('button', { name: 'ticket_closed' });
  await event.press('Enter');
  await expect(event).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Properties of ticket_closed' })).toBeVisible();
});

test.describe('in a German browser', () => {
  test.use({ locale: 'de-DE' });

  test('chart tables, axes and weekdays use the browser language', async ({ reader: page }) => {
    await page.goto('/');
    await settled(page, 'Overview');
    await page.getByRole('button', { name: 'View as table' }).click();
    const chartTable = page.getByRole('group', { name: 'Command runs and failures per day for the last 30 days' });
    await expect(chartTable.getByRole('cell').first()).toHaveText(/^\d{2}\.\d{2}\.\d{4}$/);
    await page.goto('/time');
    await settled(page, 'Time patterns');
    await expect(page.locator('.heatmap .rowlabel').first()).toHaveText(/^Mo/);
  });
});
