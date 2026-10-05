# SessionBox Architecture

> Core idea: a sandbox is not a tool the agent calls — it is the execution
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
                                          │   ├─ sandbox-A (sshd, /workspace)    │
                                          │   └─ sandbox-B (sshd, /workspace)    │
                                          └──────────────────────────────────────┘
```

- The server runs as a container with the host Docker socket mounted
  (`docs/ADR/0002-deployment-dood.md`).
- Sandboxes are **sibling containers** on the same dedicated bridge network.
  Their SSH ports are never published; the server reaches `containerIP:22`
  directly over that network.
- The web UI is served by the same server container on `:8787` in production,
  and by Vite (`:5173`, proxying `/api`) in development.

## 2. Boundaries

| Domain | Owns | Must never know |
| --- | --- | --- |
| Harness plugin (future DSH / Pi adapters) | session lifecycle, `sessionId → sandboxId`, adapting native file/shell operations | Docker, container IDs/IPs, SSH keys, sandbox lifecycle |
| SessionBox server | sandbox lifecycle, SSH/SFTP, terminal, files, auth, lifecycle policy, persistence, Web UI | DSH/Pi session internals, model context |
| Container runtime adapter | container lifecycle, networks, security flags, endpoint reachability | agent sessions, HTTP protocol |

The two sides communicate through the public HTTP/WebSocket API and
`packages/protocol` only. The server never imports harness types; plugins
never import runtime SDKs.

## 3. Runtime seam

Everything container-runtime-specific lives behind `SandboxRuntime`
(`apps/server/src/runtime/types.ts`):

- lifecycle: `ensureImage`, `create`, `start`, `stop`, `restart`, `remove`,
  `inspect`, `list`, `logs`;
- access: `openPortStream(ref, port)` — a raw duplex stream into the sandbox
  which the SSH/SFTP/terminal layer consumes. The SSH layer never learns
  whether that stream is a container IP today or a port-forward / exec bridge
  for a future runtime.

Only `apps/server/src/runtime/docker/` imports `dockerode`. A future runtime
(containerd, Kubernetes, WSLc) is added as a sibling adapter plus one branch in
`runtime/index.ts`; the sandbox service, HTTP layer and protocol stay
untouched. See `docs/ADR/0001-runtime-abstraction.md`.

## 4. Sandbox model

Public model (`packages/protocol/src/sandbox.ts`):

```
id, name, image, runtime, status, workspace,
resources { cpuLimit?, memoryLimitMb?, pidsLimit? },
lifecycle { autoStop, idleTimeoutSeconds?, maxLifetimeSeconds?, deleteAfterStop },
createdAt, startedAt?, stoppedAt?, lastActivityAt?, activeConnections
```

Internal record adds `runtimeRef` (container id / pod name), which is stripped
by an explicit projection before any response (`apps/server/src/sandbox/types.ts`).

Status machine:

```
creating ──► running ──► stopped ──► ...
    │            │
    ▼            ▼
 failed ◄────────┘        deleting ──► (record removed)
```

Operations are validated against the status (`sandbox/state.ts`) and serialized
per sandbox, so concurrent start/stop/delete calls cannot interleave.

## 5. Sandbox creation flow (current)

```text
POST /api/sandboxes
   │  id, name, image, resources, lifecycle defaults
   ▼
SandboxService.create
   │  runtime.ensureImage(image)
   │  generate ephemeral ed25519 keypair (per sandbox)
   │  credentials.save(encrypted private key)      # AES-256-GCM, master key
   │  runtime.create(spec, env:SESSIONBOX_AUTHORIZED_KEY = public key)
   │  runtime.start(ref)                            # labels: sessionbox.managed,
   │                                                # .sandbox-id, .version
   │  waitForSsh(...)                               # sshd readiness probe
   ▼
status = running
```

Sandbox containers drop all capabilities except the minimum sshd needs,
disable privilege escalation, get PID/memory/CPU limits, join the dedicated
bridge network and never publish ports.

The private key lives only in the credential store (encrypted with
`SESSIONBOX_MASTER_KEY`); the HTTP API never returns it. Deleting a sandbox
removes the credential entry.

## 6. Persistence and recovery

- SQLite via Node's built-in `node:sqlite` (no native build): `sandboxes`
  records and a `secrets` table holding AES-256-GCM sealed blobs; the schema
  version lives in `meta` and migrations are monotonic.
- Records persist `runtime` and the opaque `runtime_ref`, never Docker-specific
  column names.
- On startup `SandboxService.reconcile()`:
  1. resets stale connection counters (no connection survives a restart),
  2. syncs statuses with the runtime and marks vanished containers `failed`,
  3. **adopts** managed containers that have no record (Docker labels), so a
     lost database does not orphan sandboxes. Adopted sandboxes are manageable
     but not connectable: their SSH keys were lost with the database.

## 7. Security posture (MVP)

- Sandbox containers: non-root user, all capabilities dropped except the
  minimum sshd needs, `no-new-privileges`, PID/memory/CPU limits, no socket,
  no published ports, dedicated bridge network.
- Per-sandbox SSH credentials: ephemeral ed25519 keypair, private key sealed
  with AES-256-GCM, never returned through the API.
- API authentication: bearer tokens from `SESSIONBOX_CLIENTS` with coarse
  permissions (`sandbox:create/read/execute/write/delete/admin`), enforced on
  REST and both WebSocket surfaces. Browser sockets pass the token as a query
  parameter and the logger redacts it. Without configured clients the API is
  open (development default) and a warning is logged at startup.
- Lifecycle: auto-stop on idle timeout / maximum lifetime with
  delete-after-stop; live agent or terminal connections always keep a sandbox
  alive. Enforced by SessionBox, never by a plugin.
- The server container: trusted management plane, holds the Docker socket
  (host-root-equivalent). This is documented in ADR-0002.
- Docker isolation is a development/agent-environment boundary, **not** a
  hardened hostile-code sandbox. See `PROJECT.md` §21.

## 8. Testing strategy

| Level | What | Where |
| --- | --- | --- |
| Unit | protocol schemas, ids, state machine, service against `FakeRuntime`, credential sealing, keypair format, path validation, readiness probe | any machine (`pnpm test`) |
| HTTP | full sandbox lifecycle through `app.inject` with fakes | any machine |
| Integration | Docker lifecycle, SSH/SFTP, PTY, ports/network | remote Docker host (Day 2+) |
| Acceptance | simulated harness sessions (Day 4), real DSH/Pi adapters (when sources are available) | remote host |
