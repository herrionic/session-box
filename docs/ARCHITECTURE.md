# SessionBox Architecture

> Core idea: a container is not a tool the agent calls — it is the execution
> environment the agent session lives in.

## 1. Deployment topology (MVP)

```text
Windows / developer machine                Linux host (VPS)
┌───────────────────────┐                 ┌──────────────────────────────────────┐
│ editor + coding agent │   ssh / scp     │  sessionbox-server container         │
│ git                   │ ──────────────► │   ├─ /var/run/docker.sock (mounted)  │
│ browser ──────────────┼──── :8787 ────► │   ├─ :8787 REST + WebSocket + UI     │
└───────────────────────┘                 │   └─ manages sibling containers      │
                                          │                                      │
                                          │  docker network "sessionbox"         │
                                          │   ├─ container-A (sshd, /workspace)    │
                                          │   └─ container-B (sshd, /workspace)    │
                                          └──────────────────────────────────────┘
```

- The server runs as a container with the host Docker socket mounted
  (`docs/ADR/0002-deployment-dood.md`).
- Containers are **sibling containers** on the same dedicated bridge network.
  Their SSH ports are never published; the server reaches `containerIP:22`
  directly over that network.
- The web UI is served by the same server container on `:8787` in production,
  and by Vite (`:5173`, proxying `/api`) in development.

## 2. Boundaries

| Domain | Owns | Must never know |
| --- | --- | --- |
| Harness plugin (future DSH / Pi adapters) | session lifecycle, `sessionId → containerId`, adapting native file/shell operations | Docker, container IDs/IPs, SSH keys, container lifecycle |
| SessionBox server | container lifecycle, SSH/SFTP, terminal, files, auth, lifecycle policy, persistence, Web UI | DSH/Pi session internals, model context |
| Container runtime adapter | container lifecycle, networks, security flags, endpoint reachability | agent sessions, HTTP protocol |

The two sides communicate through the public HTTP/WebSocket API and
`packages/protocol` only. The server never imports harness types; plugins
never import runtime SDKs.

## 3. Runtime seam

Everything container-runtime-specific lives behind `ContainerRuntime`
(`apps/server/src/runtime/types.ts`):

- lifecycle: `ensureImage`, `create`, `start`, `stop`, `restart`, `remove`,
  `inspect`, `list`, `logs`;
- access: `openPortStream(ref, port)` — a raw duplex stream into the container
  which the SSH/SFTP/terminal layer consumes. The SSH layer never learns
  whether that stream is a container IP today or a port-forward / exec bridge
  for a future runtime.

Only `apps/server/src/runtime/docker/` imports `dockerode`. A future runtime
(containerd, Kubernetes, WSLc) is added as a sibling adapter plus one branch in
`runtime/index.ts`; the container service, HTTP layer and protocol stay
untouched. See `docs/ADR/0001-runtime-abstraction.md`.

## 4. Container model

Public model (`packages/protocol/src/container.ts`):

```
id, name, image, runtime, status, workspace,
resources { cpuLimit?, memoryLimitMb?, pidsLimit? },
lifecycle { autoStop, idleTimeoutSeconds?, maxLifetimeSeconds?, deleteAfterStop },
createdAt, startedAt?, stoppedAt?, lastActivityAt?, activeConnections
```

Internal record adds `runtimeRef` (container id / pod name), which is stripped
by an explicit projection before any response (`apps/server/src/container/types.ts`).

Status machine:

```
creating ──► running ──► stopped ──► ...
    │            │
    ▼            ▼
 failed ◄────────┘        deleting ──► (record removed)
```

Operations are validated against the status (`container/state.ts`) and serialized
per container, so concurrent start/stop/delete calls cannot interleave.

## 5. Container creation flow (current)

```text
POST /api/containers
   │  id, name, image, resources, lifecycle defaults
   ▼
ContainerService.create
   │  runtime.ensureImage(image)
   │  generate ephemeral ed25519 keypair (per container)
   │  credentials.save(encrypted private key)      # AES-256-GCM, master key
   │  runtime.create(spec, env:SESSIONBOX_AUTHORIZED_KEY = public key)
   │  runtime.start(ref)                            # labels: sessionbox.managed,
   │                                                # .container-id, .version
   │  waitForSsh(...)                               # sshd readiness probe
   ▼
status = running
```

Container containers drop all capabilities except the minimum sshd needs,
disable privilege escalation, get PID/memory/CPU limits, join the dedicated
bridge network and never publish ports.

The private key lives only in the credential store (encrypted with
`SESSIONBOX_MASTER_KEY`); the HTTP API never returns it. Deleting a container
removes the credential entry.

## 6. Persistence and recovery

- SQLite via Node's built-in `node:sqlite` (no native build): `containers`
  records and a `secrets` table holding AES-256-GCM sealed blobs; the schema
  version lives in `meta` and migrations are monotonic.
- Records persist `runtime` and the opaque `runtime_ref`, never Docker-specific
  column names.
- On startup `ContainerService.reconcile()`:
  1. resets stale connection counters (no connection survives a restart),
  2. syncs statuses with the runtime and marks vanished containers `failed`,
  3. **adopts** managed containers that have no record (Docker labels), so a
     lost database does not orphan containers. Adopted containers are manageable
     but not connectable: their SSH keys were lost with the database.

## 7. Security posture (MVP)

- Containers: non-root user with passwordless sudo for system-level changes,
  all capabilities dropped except the minimum sshd needs, PID/memory/CPU
  limits, no socket, no published ports, dedicated bridge network (ADR-0003).
- Per-container SSH credentials: ephemeral ed25519 keypair, private key sealed
  with AES-256-GCM, never returned through the API.
- API authentication: single-owner login (HttpOnly session cookies for the web
  UI), `sbt_…` API tokens (SHA-256 at rest) generated on the Settings page, and
  legacy `SESSIONBOX_CLIENTS` static tokens. Coarse permissions
  (`container:create/read/execute/write/delete/admin`) are enforced on REST and
  both WebSocket surfaces; WebSocket and download URLs carry the token in the
  query and the logger redacts it. Without an owner account and without
  configured clients the API is open (development default).
- Lifecycle: auto-stop on idle timeout / maximum lifetime with
  delete-after-stop; live agent or terminal connections always keep a container
  alive. Enforced by SessionBox, never by a plugin.
- The server container: trusted management plane, holds the Docker socket
  (host-root-equivalent). This is documented in ADR-0002.
- Docker isolation is a development/agent-environment boundary, **not** a
  hardened hostile-code container.

## 8. Testing strategy

| Level | What | Where |
| --- | --- | --- |
| Unit | protocol schemas, ids, state machine, service against `FakeRuntime`, credential sealing, keypair format, path validation, readiness probe | any machine (`pnpm test`) |
| HTTP | full container lifecycle through `app.inject` with fakes | any machine |
| Integration | Docker lifecycle, SSH/SFTP, PTY, ports/network | remote Docker host (Day 2+) |
| Acceptance | simulated harness sessions (Day 4), real DSH/Pi adapters (when sources are available) | remote host |
