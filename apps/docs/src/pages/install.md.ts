import type { APIRoute } from 'astro';
import prompt from '../../prompts/install.md?raw';

/** The agent install prompt as plain Markdown, at a stable URL an agent can be pointed at. */
export const GET: APIRoute = () =>
  new Response(prompt, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
