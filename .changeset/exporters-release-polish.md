---
'@shardlens/exporter-prometheus': minor
'@shardlens/exporter-otel': patch
---

Fixes found by running both exporters in a bot with no collector, scraped by Prometheus, through an OpenTelemetry
Collector and into the Grafana dashboard:

- OpenTelemetry: counts have UCUM annotation units (`{interaction}`, `{server}`, `{session}`…) instead of `1`, which
  means a ratio: Prometheus translators named three gauges `shardlens_guilds_ratio`, `shardlens_cache_size_ratio` and
  `shardlens_identify_remaining_ratio`, so the dashboard showed no servers or identify budget. Translated names are now
  the same as the Prometheus exporter's.
- OpenTelemetry: the exporter records through the global MeterProvider even when the SDK registers it after the
  exporter was created; before, every instrument stayed a no-op. The meter carries the exporter's version.
- Prometheus: `serve()` never rejects. When the port is taken (another shard process, or a restart that overlaps with
  the old process) it warns and tries again every 10 seconds instead of crashing the bot at startup; its server no
  longer keeps the process alive on its own. `ServeOptions` is exported.
- Prometheus: each label keeps at most 1,000 values per metric, later ones are counted as `(other)`, so custom event
  or command names built from IDs can't grow the registry in the bot's memory without limit.
- Prometheus: a `prefix` or `buckets` it can't use, or a registry that already holds a Shardlens metric, is replaced by
  the default with a warning instead of throwing.
- Prometheus: works with `@prometheus-io/client` 0.16, the successor of `prom-client`, installed under the name
  `prom-client` (`npm install prom-client@npm:@prometheus-io/client`).
- Grafana dashboard: a **Job** selector scopes every query, so two bots on one Prometheus no longer add up; panels for
  the slowest handlers and discord.js cache sizes; the identify budget is red when low rather than when high.
