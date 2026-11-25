import type { APIRoute, GetStaticPaths } from 'astro';

const prompts = import.meta.glob<string>('../../../prompts/*.md', { query: '?raw', import: 'default', eager: true });

/** Each package's agent prompt, as plain Markdown at `/prompts/<name>.md` (the bot's own stays at `/install.md`). */
export const getStaticPaths: GetStaticPaths = () =>
  Object.entries(prompts)
    .map(([path, text]) => ({ params: { name: path.replace(/^.*\/(.+)\.md$/, '$1') }, props: { text } }))
    .filter(({ params }) => params.name !== 'install');

export const GET: APIRoute = ({ props }) =>
  new Response(props.text as string, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
