# AGENTS.md — Working Rules for Coding Agents

SessionBox is a spec-driven repository. Read before you write.

## Required reading (in order)

1. `README.md` — what SessionBox is, quick start, boundaries
2. `docs/ARCHITECTURE.md` — boundaries, topology, data flow
3. `docs/ADR/` — accepted architectural decisions
4. `packages/protocol/src/` — the only shared contract (server ↔ plugin ↔ web)
5. The implementation files you are about to touch

## Non-negotiable architecture rules

1. **The server never learns about agent harnesses.** No DSH/Pi types, no
   `if (harness === "dsh")` inside container core logic.
2. **Plugins never see infrastructure.** No container IDs, container IPs,
   SSH keys, SSH ports or Docker details in public API responses.
3. **The container-runtime SDK is isolated.** `dockerode` (or any other
   runtime client) may be imported **only** under
   `apps/server/src/runtime/docker/`. All other server code depends on the
   thin `ContainerRuntime` interface in `apps/server/src/runtime/types.ts`.
   Never hard-code Docker assumptions outside the adapter.
4. **The public model is runtime-neutral.** Shared models live in
   `packages/protocol`; runtime internals (`ref`, socket paths, IPs) stay
   server-side.
5. **Validate at every boundary.** WebSocket and HTTP input is parsed with
   zod. Compile-time types are not a security boundary.
6. **The non-goals stay non-goals.** No Kubernetes, no
   Redis/PostgreSQL, no message queues, no microservices, no MCP, no
   scheduler, no multi-agent orchestration, no heavyweight frameworks.
7. **Security defaults are local-only.** Never publish container SSH ports,
   never mount the Docker socket into a container, never return credentials.
8. **Major design changes require an ADR** proposal in `docs/ADR/` and
   project-owner approval *before* implementation.
9. **Never implement harness integration from model memory.** Inspect the
   exact installed harness source first and document the version tested.

## Workflow

Read → Plan → Implement → Test → Explain.

- Keep changes small and focused; one concern per commit.
- Every change must leave `pnpm typecheck` and `pnpm test` green.
- Do not "fix" things that were not asked for. No speculative abstractions:
  generalize only when a second real use case exists.

## Running commands

- Package manager is pnpm, pinned via `packageManager`. If `pnpm` is not on
  PATH use `corepack pnpm ...`.
- Local development (Windows, **no Docker installed**):
  `corepack pnpm install`, `corepack pnpm typecheck`, `corepack pnpm test`.
- Docker-dependent work (building images, container lifecycle, SSH/SFTP,
  terminal integration) runs on a remote Linux host. Operator tooling and
  notes (sync/ops scripts, host address, SSH user, key path) are local-only:
  keep them in `.local/` and `.dev-notes.local.md` (both gitignored) and
  never in tracked files.
  The dev topology runs `tsx watch` + Vite via
  `docker compose -f docker-compose.yml -f compose.dev.yml up -d`; note that
  `tsx watch` does not always pick up files replaced by a tar sync — if a
  change seems ignored, restart the server container.
  Never claim Docker behaviour is verified until it has been exercised
  there; mark such work as "pending remote verification" otherwise.
- Never commit `node_modules/`, `dist/`, `.env`, `data/` or generated state.

## Layout

```
apps/server        SessionBox server (Fastify + runtime adapters)
apps/web           React web UI (Vite)
packages/protocol  Shared zod schemas and types (the only wire contract)
packages/shared    Small runtime-neutral helpers (ids, time)
images/base        Container base image (OpenSSH + tooling, non-root agent user)
docs/ADR           Architectural decision records
scripts/           Deployment probe helpers
```
