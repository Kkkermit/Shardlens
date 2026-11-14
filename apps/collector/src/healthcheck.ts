// Container healthcheck: exits 0 when the collector answers /healthz. Used by docker-compose.
const port = Number(process.env.PORT ?? 8080);
try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
