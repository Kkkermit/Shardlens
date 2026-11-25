import { gzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inProcessFetch } from '../src/in-process-fetch.js';

describe('inProcessFetch', () => {
  let app: FastifyInstance;
  let release: () => void = () => undefined;

  beforeAll(async () => {
    app = Fastify();
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    app.get('/echo', async (req) => ({ query: req.query, authorization: req.headers.authorization }));
    app.post('/echo', async (req) => ({
      bytes: (req.body as Buffer).length,
      encoding: req.headers['content-encoding'],
      acceptEncoding: req.headers['accept-encoding'] ?? null,
    }));
    app.get('/empty', async (_req, reply) => reply.code(204).send());
    app.get('/cookies', async (_req, reply) => {
      reply.header('set-cookie', ['a=1', 'b=2']);
      return { ok: true };
    });
    app.get('/slow', () => new Promise((resolve) => (release = () => resolve({ late: true }))));
    await app.ready();
  });
  afterAll(() => app.close());

  const fetch = () => inProcessFetch(app, 'slk_ingest_real');

  it('signs every request in with its own key, and keeps the query', async () => {
    const res = await fetch()('http://localhost/echo?range=7d', { headers: { authorization: 'Bearer placeholder' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: { range: '7d' }, authorization: 'Bearer slk_ingest_real' });
  });

  it('passes a gzipped body on as it is, and asks for an answer that is not compressed', async () => {
    const body = gzipSync(Buffer.from(JSON.stringify({ events: [] })));
    const res = await fetch()('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'accept-encoding': 'gzip' },
      body,
    });
    expect(await res.json()).toEqual({ bytes: body.length, encoding: 'gzip', acceptEncoding: null });
  });

  it('answers 204 with no body, and keeps every value of a repeated header', async () => {
    const empty = await fetch()('http://localhost/empty');
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    const cookies = await fetch()('http://localhost/cookies');
    expect(cookies.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('gives up a request whose signal aborts, before or while it is answered', async () => {
    const before = AbortSignal.abort(new DOMException('gone', 'AbortError'));
    await expect(fetch()('http://localhost/echo', { signal: before })).rejects.toThrow('gone');

    const timeout = new AbortController();
    const answer = fetch()('http://localhost/slow', { signal: timeout.signal });
    timeout.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await expect(answer).rejects.toMatchObject({ name: 'TimeoutError' });
    release();
  });
});
