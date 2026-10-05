# SessionBox

**SessionBox binds isolated execution environments directly to individual
coding-agent sessions.** Instead of exposing a container as an explicit tool,
SessionBox lets agent harnesses transparently run their existing filesystem
and shell capabilities inside a managed container.

SessionBox also acts as a management and access gateway: lifecycle control,
Web Terminal, file management, authentication and human intervention.

> Status: MVP in development. See `PROJECT.md` for the full specification,
> `docs/ARCHITECTURE.md` for the design and `TASKS.md` for the current board.

## Repository layout

```
apps/server        SessionBox server (Fastify + ContainerRuntime seam)
apps/web           Web UI (React + Vite)
packages/protocol  Shared zod schemas — the only wire contract
packages/shared    Small shared helpers (ids, time)
images/base        Container base image (OpenSSH, non-root agent user)
docs/              Architecture and ADRs
scripts/           Remote sync / operations helpers
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

Container creation needs `SESSIONBOX_MASTER_KEY` (base64, 32 bytes) to encrypt
per-container SSH credentials:

```bash
openssl rand -base64 32
# or: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Docker is not required for unit/HTTP tests (they run against `FakeRuntime`),
but container lifecycle, SSH/SFTP and the terminal need a Docker host.

## Remote deployment (Docker host)

The server is designed to run as a container on the Docker host it manages:

```bash
# on the host (or via scripts/sync.ps1 + scripts/remote.ps1 from Windows)
cp .env.example .env          # set SESSIONBOX_MASTER_KEY
docker build -t sessionbox/base:latest images/base
docker compose up -d --build
```

The container mounts `/var/run/docker.sock`, creates container containers as
siblings on the shared `sessionbox` bridge network, and never publishes container
SSH ports. See `docs/ADR/0002-deployment-dood.md` for the security rationale.

From a Windows workstation:

```powershell
.\scripts\sync.ps1 -HostName <ssh-host>
.\scripts\remote.ps1 up -d --build
.\scripts\remote.ps1 logs -f server
```

## Boundaries

- The server knows containers, never agent-session internals (no DSH/Pi types).
- Plugins know sessions, never Docker, keys or ports.
- Container-runtime specifics (`dockerode`) live only under
  `apps/server/src/runtime/docker/`; everything else depends on the thin
  `ContainerRuntime` interface (`docs/ADR/0001-runtime-abstraction.md`).
