import { describe, expect, it } from 'vitest';
import { privacyParagraph } from '../src/privacy.js';

describe('privacyParagraph', () => {
  it('describes privacy mode by default and audit mode only when asked', () => {
    const privacy = privacyParagraph({});
    expect(privacy).toContain('pseudonymous code');
    expect(privacy).not.toContain('encrypted');
    expect(privacy).toContain('kept for 35 days');
    const audit = privacyParagraph({ audit: true, optionValues: ['category'] });
    expect(audit).toContain('user ID, username and avatar');
    expect(audit).toContain('for up to 30 days');
    expect(audit).toContain('For the option "category" it also records');
    expect(privacyParagraph({ optionValues: ['language', 'category'] })).toContain(
      'For the options "language" and "category" it also records the values you choose',
    );
    expect(privacyParagraph({ audit: true, idsOnly: true })).not.toContain('username');
  });

  it('is in audit mode whenever an audit-only option is given', () => {
    expect(privacyParagraph({ idsOnly: true })).toContain('records your Discord user ID with each command, encrypted');
    expect(privacyParagraph({ auditRetentionDays: 14 })).toContain('for up to 14 days');
  });

  it('names everything recorded about the person, as the data-collected register lists it', () => {
    const text = privacyParagraph({});
    expect(text).toContain('an admin, a manager or a member');
    expect(text).toContain('premium');
    // Salts rotate daily, weekly or monthly, and are destroyed a week after their period ends.
    expect(text).toContain('changes at least once a month; a week after each change');
  });
});
