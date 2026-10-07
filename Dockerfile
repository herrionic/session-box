# SessionBox server image.
#
# Builds the server bundle and the web UI, then runs the server with production
# dependencies only. The container needs /var/run/docker.sock mounted to manage
# container containers on the host (see docs/ADR/0002-deployment-dood.md).
#
# NOTE: image building is verified on the remote Linux host, not on the
# development machine (no Docker available locally).

# syntax=docker/dockerfile:1

FROM node:24-slim AS base
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# ---------- dependencies (all workspaces, dev included) ----------
FROM base AS deps
COPY packages ./packages
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---------- dev image target (source bind-mounted by compose.dev.yml) ----------
FROM deps AS dev
COPY tsconfig.base.json ./
COPY apps ./apps
CMD ["pnpm", "--filter", "@sessionbox/server", "dev"]

# ---------- build server bundle + web assets ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps ./apps
RUN pnpm --filter @sessionbox/server build \
 && pnpm --filter @sessionbox/web build

# ---------- production dependencies only ----------
FROM base AS prod-deps
COPY packages ./packages
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --filter @sessionbox/server

# ---------- runtime ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /repo/packages ./packages
COPY --from=build /repo/apps/server/package.json ./apps/server/package.json
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/web/dist ./apps/web/dist

# The server container runs as root on purpose: the mounted docker.sock already
# grants host-root-equivalent power, and the socket is normally root:docker 660.
# See docs/ADR/0002-deployment-dood.md.
RUN mkdir -p /data
ENV SESSIONBOX_DATA_DIR=/data \
    SESSIONBOX_WEB_DIST=/repo/apps/web/dist \
    SESSIONBOX_PORT=8787

EXPOSE 8787
CMD ["node", "apps/server/dist/main.js"]
