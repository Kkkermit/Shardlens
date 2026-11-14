/** Discord Developer Policy (effective 8 July 2024) rules Shardlens maps to. */
export const POLICY_RULES: Record<number, { requirement: string; compliance: string }> = {
  3: {
    requirement: 'Do not bypass Discord privacy and safety features; respect users who opt out or block the app.',
    compliance: 'optOut(), the /privacy command, and no scraping.',
  },
  7: {
    requirement: 'Do not contact users outside Discord using API data.',
    compliance: 'Shardlens has no contact features.',
  },
  9: { requirement: 'Not directed at children under 13; no data from them.', compliance: 'No age data is collected.' },
  15: {
    requirement:
      'Collect only what is necessary for the functionality you describe; use aggregated or de-identified data to improve your app.',
    compliance:
      'Privacy mode is the default. Audit mode is framed as support and abuse-handling functionality, with guardrails.',
  },
  16: {
    requirement: 'No profiling of users or their relationships.',
    compliance: 'No per-user profile pages, and the query API cannot group by user.',
  },
  17: {
    requirement: 'No disclosure to data brokers or ad networks.',
    compliance: 'Self-hosted, with no third-party telemetry.',
  },
  18: { requirement: 'No selling of API data.', compliance: 'Self-hosted, with no third-party telemetry.' },
  19: {
    requirement: 'No re-identification of de-identified data.',
    compliance: 'Salts are destroyed, and there is no reverse lookup in privacy mode.',
  },
  20: { requirement: 'No mining or scraping.', compliance: 'Only data Discord sends to the bot is used.' },
  21: { requirement: 'No AI training on message content.', compliance: 'Message content is never collected.' },
};
