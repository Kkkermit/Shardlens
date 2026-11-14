import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';
import { BASE_URL } from './env';

type Fixtures = {
  /** Console errors and uncaught page errors seen during the test; asserted empty afterwards. */
  pageErrors: string[];
  /** A page signed in with a read-key session. */
  reader: Page;
  /** A page signed in as the app owner (Discord session). */
  admin: Page;
};

async function signIn(page: Page, token: string | undefined) {
  if (!token) throw new Error('global setup did not create a session');
  await page.context().addCookies([{ name: 'shardlens_session', value: token, url: BASE_URL }]);
}

export const test = base.extend<Fixtures>({
  pageErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    await use(errors);
    expect(errors, 'console errors').toEqual([]);
  },
  reader: async ({ page, pageErrors: _ }, use) => {
    await signIn(page, process.env.SHARDLENS_E2E_READER);
    await use(page);
  },
  admin: async ({ page, pageErrors: _ }, use) => {
    await signIn(page, process.env.SHARDLENS_E2E_ADMIN);
    await use(page);
  },
});

/**
 * WCAG 2.1 A and AA checks plus axe's best practices (the rules Lighthouse's accessibility score is built from); any
 * violation fails the test, with the rule IDs and targets in the message.
 */
export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(summary, 'axe violations').toEqual([]);
}

export { expect };
