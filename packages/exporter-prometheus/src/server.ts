import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Registry } from 'prom-client';
import { warn } from './warn.js';

/** Where the metrics server listens. */
export interface ServeOptions {
  /** Default `9464`. Give each process of a sharded bot its own port. */
  port?: number | undefined;
  /** Default `127.0.0.1`. Use `0.0.0.0` when Prometheus runs in another container or on another machine. */
  host?: string | undefined;
}

/** A running metrics server. */
export interface MetricsServer {
  /** The port it listens on (the one chosen by the system for port `0`), or `0` while it can't listen yet. */
  readonly port: number;
  /** Stops listening and closes open connections. */
  close(): Promise<void>;
}

/**
 * A port in use is often one a previous process of the bot still holds while it shuts down (a rolling restart), so
 * it is tried again until it is free.
 */
const RETRY_MS = 10_000;

async function respond(registry: Registry, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' || (req.url ?? '/').split('?')[0] !== '/metrics') {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await registry.metrics();
    res.writeHead(200, { 'content-type': registry.contentType }).end(body);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

/**
 * Serves `GET /metrics` from `registry`, keeping the server in `servers` until it is closed. Never rejects and never
 * lets a server error reach the bot: when the port can't be used it warns once, and tries again while it is in use.
 */
export function serveMetrics(
  registry: Registry,
  options: ServeOptions,
  servers: Set<MetricsServer>,
): Promise<MetricsServer> {
  const port = options.port ?? 9464;
  const host = options.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    respond(registry, req, res).catch(() => res.destroy());
  });
  // The bot decides when its process ends, not its metrics endpoint.
  server.unref();
  let closed = false;
  let warned = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const handle: MetricsServer = {
    get port() {
      const address = server.address();
      return typeof address === 'object' && address !== null ? address.port : 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        clearTimeout(retry);
        servers.delete(handle);
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  servers.add(handle);

  return new Promise<MetricsServer>((resolve) => {
    const listen = () => {
      server.listen(port, host, () => {
        if (closed) server.close();
        resolve(handle);
      });
    };
    // Kept for the server's lifetime: an 'error' event without a listener would crash the bot.
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (server.listening || closed) return;
      const inUse = error.code === 'EADDRINUSE';
      if (!warned) {
        warned = true;
        warn(
          `can't serve metrics on ${host}:${port} (${error.code ?? error.message})${inUse ? '; trying again every 10 seconds' : ''}.`,
        );
      }
      if (inUse) {
        retry = setTimeout(listen, RETRY_MS);
        retry.unref();
      }
      resolve(handle);
    });
    listen();
  });
}
