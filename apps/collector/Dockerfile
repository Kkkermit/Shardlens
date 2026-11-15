# syntax=docker/dockerfile:1.7
# Shardlens collector (serves the API and the built dashboard). Build from the repository root:
#   docker build -f apps/collector/Dockerfile -t shardlens-collector .

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
# No git hooks inside the image build.
ENV HUSKY=0
WORKDIR /repo
RUN corepack enable
# Manifests first, so dependency installs are cached until a lockfile or manifest changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
# Every package copied below, or the build step installs again when the rest arrive.
COPY packages/schema/package.json packages/schema/
COPY packages/core/package.json packages/core/
COPY packages/discordjs/package.json packages/discordjs/
COPY packages/http/package.json packages/http/
COPY packages/cli/package.json packages/cli/
COPY packages/exporter-prometheus/package.json packages/exporter-prometheus/
COPY packages/exporter-otel/package.json packages/exporter-otel/
COPY apps/collector/package.json apps/collector/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/collector apps/collector
COPY apps/dashboard apps/dashboard
RUN pnpm turbo run build --filter=@shardlens/collector... --filter=@shardlens/dashboard
# A self-contained copy of the collector with production dependencies only.
RUN pnpm --filter @shardlens/collector deploy --prod --legacy /out

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# The dashboard is in public/, as in the npm package (the collector's build copies it there without source maps). The
# files stay owned by root: the collector's user can read its code but not change it, even without a read-only disk.
COPY --from=build /out ./
USER 10001:10001
EXPOSE 8080
# The start period covers migrations, which on a large database can take a few minutes after an upgrade.
HEALTHCHECK --interval=30s --timeout=5s --start-period=2m CMD ["node", "dist/healthcheck.js"]
LABEL org.opencontainers.image.source="https://github.com/Kkkermit/Shardlens" \
      org.opencontainers.image.description="Shardlens collector and dashboard" \
      org.opencontainers.image.licenses="MIT"
CMD ["node", "dist/main.js"]
