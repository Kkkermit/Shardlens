---
'@shardlens/core': minor
'@shardlens/discordjs': minor
'@shardlens/exporter-prometheus': minor
'@shardlens/exporter-otel': minor
---

Prometheus and OpenTelemetry exporters. Pass `exporters: [prometheusExporter()]` or `[openTelemetryExporter()]` to
`createShardlens` to get bot-health metrics (interactions by command and outcome, response time, REST, rate limits,
shards, memory) in your own monitoring, with or without a collector: `endpoint` and `apiKey` are now optional.
Exporters see every event before sampling, never with a user, and no metric is labelled by user or server ID.
