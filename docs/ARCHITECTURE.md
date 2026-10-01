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

```
POST /api/sandboxes
   │  id, name, image, resources, lifecycle defaults
   ▼
SandboxService.create
   │  runtime.ensureImage(image)
   │  runtime.create(spec)        # labels: sessionbox.managed, .sandbox-id, .version
   │  runtime.start(ref)         # capabilities dropped, no-new-privileges,
   ▼                             # pids/memory/cpu limits, private bridge network
status = running
```

Day 2 adds: ephemeral SSH keypair, encrypted credential storage, public-key
injection via `SESSIONBOX_AUTHORIZED_KEY`, and an SSH readiness probe before
marking the sandbox `running`.

## 6. Persistence and recovery

- `SandboxRepository` is the persistence boundary; the MVP boots with an
  in-memory implementation and swaps in SQLite (Day 6).
- Records persist `runtime` and the opaque `runtime_ref`, never
  Docker-specific column names.
- Managed containers carry Docker labels, so reconciliation after a restart
  can map runtime state back to sandbox records (`SandboxService.reconcile`).

## 7. Security posture (MVP)

- Sandbox containers: non-root user, all capabilities dropped except the
  minimum sshd needs, `no-new-privileges`, PID/memory/CPU limits, no socket,
  no published ports, dedicated bridge network.
- The server container: trusted management plane, holds the Docker socket
  (host-root-equivalent). This is documented in ADR-0002.
- Docker isolation is a development/agent-environment boundary, **not** a
  hardened hostile-code sandbox. See `PROJECT.md` §21.

## 8. Testing strategy

| Level | What | Where |
| --- | --- | --- |
| Unit | protocol schemas, id helpers, state machine, service against `FakeRuntime`, error mapping, config | any machine (`pnpm test`) |
| HTTP | full sandbox lifecycle through `app.inject` with `FakeRuntime` | any machine |
| Integration | Docker lifecycle, SSH/SFTP, PTY, ports/network | remote Docker host (Day 2+) |
| Acceptance | simulated harness sessions (Day 4), real DSH/Pi adapters (when sources are available) | remote host |
