import { list } from './list.js';

interface PrivacyOptions {
  /** Identified users (audit mode). Implied by `idsOnly` and `auditRetentionDays`. */
  audit?: boolean;
  /** Audit mode with `auditIncludeProfile: false`. */
  idsOnly?: boolean;
  optionValues?: string[];
  webhookEvents?: boolean;
  /** Raw-data retention (`rawRetentionDays` in the settings), default 35. */
  retentionDays?: number;
  /** Audit retention (`auditRetentionDays` in the settings), default 30. */
  auditRetentionDays?: number;
}

/** A plain-language paragraph for the bot's privacy policy, matching the configuration. Not legal advice. */
export function privacyParagraph(o: PrivacyOptions): string {
  const audit = o.audit || o.idsOnly || o.auditRetentionDays !== undefined;
  const parts = [
    'This bot uses Shardlens, a self-hosted analytics tool, to understand how it is used and to keep it reliable.',
    'When you use one of its commands, buttons or menus, it records which one, when, in which server (or in DMs), your Discord app language, whether you are an admin, a manager or a member there, whether you are using it as a server or user install, whether you or the server have premium, and whether it worked and how quickly.',
    o.optionValues?.length
      ? `For the option${o.optionValues.length > 1 ? 's' : ''} ${list(o.optionValues.map((v) => `"${v}"`))} it also records the values you choose; other option values are not recorded.`
      : 'It records which command options you use, but not the values you enter.',
    audit
      ? `For support and abuse prevention it also records your Discord user ID${o.idsOnly ? '' : ', username and avatar'} with each command, encrypted, and keeps this for up to ${o.auditRetentionDays ?? 30} days. Access to this information is restricted to the bot's team and every access is logged.`
      : // The salt period is a month at most (day, week or month), and a salt is destroyed a week after its period.
        'Your Discord user ID is replaced inside the bot with a pseudonymous code that changes at least once a month; a week after each change, the old code can no longer be linked to you.',
    o.webhookEvents
      ? 'When you add or remove the bot, Discord reports it to Shardlens, and your user ID is handled as described above.'
      : '',
    'Shardlens never reads your messages, and the data stays on infrastructure run by the bot owner; it is not sold or shared with third parties.',
    `Detailed records are kept for ${o.retentionDays ?? 35} days; after that only anonymous totals remain.`,
    'You can stop this recording, or ask for your recorded data to be deleted, with the /privacy command or by contacting the bot owner.',
  ];
  return parts.filter(Boolean).join(' ');
}
