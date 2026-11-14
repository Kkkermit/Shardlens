# syntax=docker/dockerfile:1.7
# Shardlens collector (serves the API and the built dashboard). Build from the repository root:
#   docker build -f apps/collector/Dockerfile -t shardlens-collector .

FROM node:24-slim AS build
# No git hooks inside the image build.
ENV HUSKY=0
WORKDIR /repo
RUN corepack enable
# Manifests first, so dependency installs are cached until a lockfile or manifest changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/core/package.json packages/core/
COPY packages/discordjs/package.json packages/discordjs/
COPY apps/collector/package.json apps/collector/
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/collector apps/collector
COPY apps/dashboard apps/dashboard
RUN pnpm turbo run build --filter=@shardlens/collector... --filter=@shardlens/dashboard
# A self-contained copy of the collector with production dependencies only.
RUN pnpm --filter @shardlens/collector deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=10001:10001 /out ./
COPY --from=build --chown=10001:10001 /repo/apps/dashboard/dist ./public
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "dist/healthcheck.js"]
LABEL org.opencontainers.image.source="https://github.com/Kkkermit/Shardlens" \
      org.opencontainers.image.description="Shardlens collector and dashboard" \
      org.opencontainers.image.licenses="MIT"
CMD ["node", "dist/main.js"]
