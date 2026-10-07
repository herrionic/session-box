# SessionBox

**SessionBox binds isolated execution environments directly to individual
coding-agent sessions.** Instead of exposing a container as an explicit tool,
SessionBox lets agent harnesses transparently run their existing filesystem
and shell capabilities inside a managed container.

SessionBox also acts as a management and access gateway: lifecycle control,
Web Terminal, file management, authentication and human intervention.

> Status: MVP in development. See `docs/ARCHITECTURE.md` for the design.

## Quick start (Docker)

```bash
docker build -t sessionbox/base:latest images/base
docker compose up -d --build
```

Open the web UI on port **8787**. A setup wizard appears automatically on the
first visit and creates the owner account — that is the only required step.
Everything else works out of the box: the server generates and persists its own
master key (`<data dir>/master.key`) and manages its network on the host.

`.env` is optional and only used to override defaults for automated
deployments (see `.env.example`).

## Repository layout

```
apps/server        SessionBox server (Fastify + ContainerRuntime seam)
apps/web           Web UI (React + Vite)
packages/protocol  Shared zod schemas — the only wire contract
packages/shared    Small shared helpers (ids, time)
images/base        Container base image (OpenSSH, non-root agent user)
docs/              Architecture and ADRs
scripts/           Deployment probe helper
```

## Development

Requires Node.js 24+ and pnpm (pinned via `corepack`).

```bash
pnpm install
pnpm dev          # API server on :8787
pnpm dev:web      # Vite dev server on :5173 (proxies /api)
pnpm typecheck
pnpm test
```

The master key that encrypts per-container SSH credentials is generated and
persisted automatically (`<data dir>/master.key`). Set `SESSIONBOX_MASTER_KEY`
(base64, 32 bytes) only to override it.

Docker is not required for unit/HTTP tests (they run against `FakeRuntime`),
but container lifecycle, SSH/SFTP and the terminal need a Docker host.

## Remote deployment (Docker host)

The server is designed to run as a container on the Docker host it manages:

```bash
# on the host (or from a synced working copy)
docker build -t sessionbox/base:latest images/base
docker compose up -d --build
```

The container mounts `/var/run/docker.sock`, creates containers as siblings on
its Docker host, and never publishes container SSH ports. See
`docs/ADR/0002-deployment-dood.md` for the security rationale.

## Boundaries

- The server knows containers, never agent-session internals (no DSH/Pi types).
- Plugins know sessions, never Docker, keys or ports.
- Container-runtime specifics (`dockerode`) live only under
  `apps/server/src/runtime/docker/`; everything else depends on the thin
  `ContainerRuntime` interface (`docs/ADR/0001-runtime-abstraction.md`).
