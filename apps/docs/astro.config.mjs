// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightOpenAPI, { openAPISidebarGroups } from 'starlight-openapi';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

// GitHub Pages serves the site under /Shardlens/ unless a custom domain is configured.
const site = process.env.DOCS_SITE ?? 'https://kkkermit.github.io';
const base = process.env.DOCS_BASE ?? '/Shardlens';
const docsUrl = (path) => `${site}${base}${path}`;
const shareImage = docsUrl('/og.png');
const shareImageAlt = 'Shardlens: self-hosted, privacy-first analytics and health monitoring for discord.js bots';

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'Shardlens',
      description: 'Self-hosted, privacy-first analytics and health monitoring for discord.js bots.',
      logo: { src: './src/assets/logo.svg' },
      // Browsers that don't take the SVG (Safari, older ones), phones and link previews get these.
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: `${base}/favicon.ico`, sizes: '32x32' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}/apple-touch-icon.png` } },
        { tag: 'link', attrs: { rel: 'manifest', href: `${base}/site.webmanifest` } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0d2240' } },
        { tag: 'meta', attrs: { name: 'robots', content: 'index, follow, max-image-preview:large, max-snippet:-1' } },
        { tag: 'meta', attrs: { property: 'og:image', content: shareImage } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: shareImageAlt } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: shareImage } },
        { tag: 'meta', attrs: { name: 'twitter:image:alt', content: shareImageAlt } },
        {
          tag: 'link',
          attrs: {
            rel: 'alternate',
            type: 'text/plain',
            href: `${base}/llms.txt`,
            title: 'Documentation for AI agents',
          },
        },
      ],
      routeMiddleware: './src/route-data.ts',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Kkkermit/Shardlens' }],
      editLink: { baseUrl: 'https://github.com/Kkkermit/Shardlens/edit/main/apps/docs/' },
      lastUpdated: false,
      plugins: [
        starlightLinksValidator({ errorOnRelativeLinks: false }),
        starlightLlmsTxt({
          projectName: 'Shardlens',
          description:
            'Shardlens is self-hosted, privacy-first analytics and health monitoring for discord.js bots: an SDK inside the bot (`@shardlens/discordjs`) sends events to a collector and dashboard the bot owner runs. User IDs are hashed inside the bot, message content is never collected, and only the `Guilds` intent is needed.',
          details: [
            `To add Shardlens to a bot, follow the step-by-step agent prompt at ${docsUrl('/install.md')}. It is self-contained.`,
            '',
            '- Packages: `@shardlens/discordjs` (gateway bots, discord.js 14 and 15), `@shardlens/http` (HTTP-interaction bots), `@shardlens/client` (reads the collector from your own dashboard or scripts), `@shardlens/exporter-prometheus`, `@shardlens/exporter-otel`, `shardlens` (CLI), `@shardlens/collector` (collector and embedded mode).',
            '- Requirements: Node.js 22.12 or newer for the SDK; Docker and PostgreSQL 16 or 17 for the collector.',
            '- Never suggest privileged intents, per-user views or sending message content: Shardlens has none by design.',
          ].join('\n'),
          promote: ['getting-started/**', 'guides/**', 'concepts/**'],
          demote: ['reference/sdk/**', 'reference/http-api/**', 'contributing/**'],
          exclude: ['reference/sdk/**', 'reference/http-api/**', 'contributing/**'],
          optionalLinks: [
            { label: 'Source code', url: 'https://github.com/Kkkermit/Shardlens' },
            { label: 'Decision records', url: 'https://github.com/Kkkermit/Shardlens/tree/main/docs/adr' },
          ],
        }),
        starlightTypeDoc({
          entryPoints: [
            '../../packages/discordjs/src/index.ts',
            '../../packages/http/src/index.ts',
            '../../packages/client/src/index.ts',
            '../../packages/exporter-prometheus/src/index.ts',
            '../../packages/exporter-otel/src/index.ts',
            '../../packages/core/src/index.ts',
          ],
          tsconfig: './tsconfig.typedoc.json',
          output: 'reference/sdk',
          sidebar: { label: 'SDK reference', collapsed: true },
          typeDoc: {
            excludePrivate: true,
            excludeInternal: true,
            gitRevision: 'main',
            readme: './typedoc-readme.md',
            plugin: ['./scripts/typedoc-module-names.mjs'],
          },
        }),
        starlightOpenAPI([
          {
            base: 'reference/http-api',
            schema: './src/generated/openapi.json',
            sidebar: { label: 'HTTP API', collapsed: true },
          },
        ]),
      ],
      sidebar: [
        { label: 'Getting started', items: [{ autogenerate: { directory: 'getting-started' } }] },
        { label: 'Self-hosting', items: [{ autogenerate: { directory: 'self-hosting' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', slug: 'reference/cli' },
            { label: 'Collector environment', slug: 'reference/environment' },
            typeDocSidebarGroup,
            ...openAPISidebarGroups,
          ],
        },
        { label: 'Operations', items: [{ autogenerate: { directory: 'operations' } }] },
        { label: 'Contributing', items: [{ autogenerate: { directory: 'contributing' } }] },
      ],
    }),
  ],
});
