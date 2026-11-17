# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/quickadd/package.json packages/quickadd/package.json
COPY packages/recurrence/package.json packages/recurrence/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/android/package.json apps/android/package.json

RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY apps/web/ apps/web/
COPY apps/server/ apps/server/

RUN pnpm --filter @noortasks/quickadd build \
 && pnpm --filter @noortasks/web build

FROM base AS runtime
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/quickadd/package.json packages/quickadd/package.json
COPY packages/recurrence/package.json packages/recurrence/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/android/package.json apps/android/package.json

# Install only server and workspace runtime dependencies (keeps tsx while omitting web/playwright/android deps)
RUN pnpm install --frozen-lockfile --filter @noortasks/server... \
 && pnpm store prune \
 && rm -rf /root/.local/share/pnpm/store

COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/recurrence/src packages/recurrence/src
COPY packages/recurrence/tsconfig.json packages/recurrence/tsconfig.json
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY --from=builder /app/apps/web/dist apps/web/dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data/files \
 && chown -R node:node /app /data

USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8099
ENV NOORTASKS_DB=/data/noortasks.sqlite
ENV NOORTASKS_DATA_DIR=/data/files
ENV NOORTASKS_CONFIG=/data/config.json
ENV NOORTASKS_STATIC_DIR=/app/apps/web/dist

VOLUME ["/data"]
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8099) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/app/apps/server/node_modules/.bin/tsx", "/app/apps/server/src/main.ts"]
