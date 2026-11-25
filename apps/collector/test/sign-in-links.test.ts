import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignInLinks } from '../src/security/sign-in-links.js';

const tokenOf = (link: string) => new URL(link).pathname.split('/').pop() ?? '';

describe('SignInLinks', () => {
  afterEach(() => vi.useRealTimers());

  it('redeems a link once', () => {
    const links = new SignInLinks();
    const token = tokenOf(links.issue('http://localhost:8080/'));
    expect(links.redeem(token)).toBe(true);
    expect(links.redeem(token)).toBe(false);
  });

  it('refuses a link after 15 minutes', () => {
    vi.useFakeTimers();
    const links = new SignInLinks();
    const token = tokenOf(links.issue('http://localhost:8080/'));
    vi.advanceTimersByTime(15 * 60_000);
    expect(links.redeem(token)).toBe(false);
  });

  it('keeps links of other processes and made-up tokens out', () => {
    const token = tokenOf(new SignInLinks().issue('http://localhost:8080/'));
    expect(new SignInLinks().redeem(token)).toBe(false);
    expect(new SignInLinks().redeem('')).toBe(false);
  });

  it('builds the link under the dashboard URL it is given', () => {
    expect(new SignInLinks().issue('https://stats.example.com/')).toMatch(
      /^https:\/\/stats\.example\.com\/auth\/link\/[\w-]{43}$/,
    );
  });
});
