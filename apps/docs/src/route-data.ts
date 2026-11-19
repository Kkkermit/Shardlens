import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

type HeadEntry = App.Locals['starlightRoute']['head'][number];

const HOME_TITLE = 'Shardlens: self-hosted analytics and bot health for discord.js';

/** Escaped so text from a page can't close the script tag. */
const jsonLd = (data: object): HeadEntry => ({
  tag: 'script',
  attrs: { type: 'application/ld+json' },
  content: JSON.stringify({ '@context': 'https://schema.org', ...data }).replace(/</g, '\\u003c'),
});

/**
 * Per page: structured data for search engines (the site on the home page, an article with its breadcrumb on every
 * other), the home page's own title, and `noindex` on the 404 page.
 */
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const { head } = route;
  const tag = (name: string, attr: string, value: string) =>
    head.find((entry) => entry.tag === name && entry.attrs?.[attr] === value);

  if (route.id === '404') {
    const robots = tag('meta', 'name', 'robots');
    if (robots?.attrs) robots.attrs.content = 'noindex, follow';
    return;
  }

  // With its trailing slash: it is the canonical URL of the home page, and other URLs are resolved against it.
  const home = new URL(import.meta.env.BASE_URL.replace(/\/?$/, '/'), context.site).href;
  const url = String(tag('link', 'rel', 'canonical')?.attrs?.href ?? new URL(context.url.pathname, context.site).href);
  const description = String(tag('meta', 'name', 'description')?.attrs?.content ?? '');
  const image = new URL('og.png', home).href;
  const website = { '@type': 'WebSite', '@id': `${home}#website`, name: 'Shardlens', url: home, inLanguage: 'en' };
  const publisher = {
    '@type': 'Organization',
    name: 'Shardlens',
    url: home,
    logo: { '@type': 'ImageObject', url: new URL('icon-512.png', home).href },
  };

  if (url === home) {
    const title = head.find((entry) => entry.tag === 'title');
    if (title) title.content = HOME_TITLE;
    const ogTitle = tag('meta', 'property', 'og:title');
    if (ogTitle?.attrs) ogTitle.attrs.content = HOME_TITLE;
    const ogType = tag('meta', 'property', 'og:type');
    if (ogType?.attrs) ogType.attrs.content = 'website';
    head.push(
      jsonLd({
        '@graph': [
          { ...website, description },
          {
            '@type': 'SoftwareApplication',
            name: 'Shardlens',
            description,
            url: home,
            image,
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Linux, macOS, Windows',
            license: 'https://opensource.org/license/mit',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            sameAs: ['https://github.com/Kkkermit/Shardlens', 'https://www.npmjs.com/package/@shardlens/discordjs'],
          },
        ],
      }),
    );
    return;
  }

  const headline = route.entry.data.title;
  head.push(
    jsonLd({
      '@graph': [
        {
          '@type': 'TechArticle',
          headline,
          description,
          url,
          image,
          inLanguage: 'en',
          isPartOf: { '@id': `${home}#website` },
          publisher,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Shardlens', item: home },
            { '@type': 'ListItem', position: 2, name: headline, item: url },
          ],
        },
      ],
    }),
  );
});
