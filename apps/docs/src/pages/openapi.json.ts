import type { APIRoute } from 'astro';
import document from '../generated/openapi.json?raw';

/** The collector's HTTP API as an OpenAPI document, for agents and code generators without a collector to ask. */
export const GET: APIRoute = () =>
  new Response(document, { headers: { 'content-type': 'application/json; charset=utf-8' } });
