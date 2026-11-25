import type { APIRoute } from 'astro';

/**
 * Everything may be crawled, by search engines and AI agents alike. Crawlers only read robots.txt at the root of a
 * host, so this file takes effect on a custom domain; under `<user>.github.io/<repo>/` nothing restricts crawling.
 */
/** Crawlers of AI search and assistants. All of them may read everything. */
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'meta-externalagent',
  'Amazonbot',
  'DuckAssistBot',
  'cohere-ai',
  'MistralAI-User',
];

export const GET: APIRoute = ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const url = (path: string) => new URL(`${base}${path}`, site).href;
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    // Named as well, for crawlers that only follow a group of their own.
    ...AI_CRAWLERS.map((agent) => `User-agent: ${agent}`),
    'Allow: /',
    '',
    `# Documentation as plain text for AI agents: ${url('/llms.txt')}`,
    `Sitemap: ${url('/sitemap-index.xml')}`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
