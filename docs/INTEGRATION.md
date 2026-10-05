# SessionBox Integration Protocol

How a client connects to a SessionBox service. This document is the integration
contract: authentication, session → container binding, capability mapping,
lifecycle ownership and failure semantics. Wire-level message schemas live in
[`PROTOCOL.md`](PROTOCOL.md).

```text
client ──REST + WebSocket──▶ SessionBox server ──SSH (per-container key)──▶ container
                                   │
                                   └── container runtime (server-side only)
```

- The client speaks only the public API. Containers are addressed by their
  public id; container IPs, ports, SSH keys and runtime handles never leave the
  server.
- The server owns container lifecycle; the client owns session lifecycle. A
  disconnect never stops or deletes a container.

## 1. Authentication

Create a token in the web UI (**Settings → API tokens**). Tokens look like
`sbt_…`; the plaintext is shown once and only a SHA-256 hash is stored.

| Transport | How to authenticate |
| --- | --- |
| REST | `Authorization: Bearer <token>` |
| Agent / terminal WebSocket | `?token=<token>` query parameter (WebSocket clients cannot set headers); the server strips it before route validation and redacts it in logs |

- `401 UNAUTHORIZED` — missing or unknown token, or an expired session.
- `403 FORBIDDEN` — valid token without the required permission.
- Permissions: `container:create`, `container:read`, `container:execute`,
  `container:write`, `container:delete`, `container:admin` (`*` grants all).
  Suggested mapping: REST reads → `read`; exec/terminal/start/stop/restart →
  `execute`; file mutations → `write`; delete → `delete`; settings → `admin`.
- Legacy `SESSIONBOX_CLIENTS` static tokens remain valid; prefer `sbt_…`.
- `/api/health`, `/api/setup*` and the login routes are public; everything
  else requires authentication.

## 2. REST surface

All endpoints are JSON; errors use the envelope
`{ "error": { "code", "message", "requestId", "details?" } }`.

| Method & path | Purpose |
| --- | --- |
| `POST /api/containers` | Create and start a container (`name`, `image`, `resources`, `lifecycle`, `networks` optional) |
| `GET /api/containers` | List managed containers |
| `GET /api/containers/:id` | Status, workspace, networks, resources |
| `POST /api/containers/:id/start` \| `/stop` \| `/restart` | Lifecycle |
| `DELETE /api/containers/:id` | Delete (container + credentials + private network) |
| `PATCH /api/containers/:id/settings` | Lifecycle settings |
| `GET /api/networks` | Shared networks (cross-session access) |
| `POST` / `DELETE /api/containers/:id/networks/:name` | Attach / detach a shared network |

Creation defaults: 1 CPU, 1024 MB, 512 pids. Every container gets its own
private network and is reachable by the server only.

## 3. Agent protocol — `WS /api/ws/agent`

1. Handshake: send `{ "type": "hello", "protocolVersion": 2, "client": "<name>" }`
   and expect `{ "type": "welcome", "protocolVersion": 2 }`. A version mismatch
   is rejected; there is no negotiation or fallback.
2. Requests are validated and correlated by `requestId`; one connection may
   serve several containers.
3. Operations: `exec`, `exec.cancel`, `file.read`, `file.readBytes`,
   `file.write`, `file.rename`, `file.chmod`, `file.symlink`, `file.list`,
   `file.stat`, `file.mkdir`, `file.remove`, `terminal.open` — exact shapes in
   [`PROTOCOL.md`](PROTOCOL.md) §2. `terminal.input`/`resize`/`close` are
   one-way control frames.
4. `exec` carries `command`, optional `cwd` and `timeoutMs`, and runs through a
   real SSH channel as the non-root `agent` user (uid 1000) inside the
   container. `exec.stdout`/`exec.stderr` frames preview output while it runs;
   the terminal response is always `exec.result` with the complete output.
   `exec.cancel` targets an in-flight exec by `requestId` and kills its whole
   process group; the target then fails with `OPERATION_CANCELLED`.
5. Files: `file.read` is text-only and fails with `FS_NOT_TEXT` when the
   content is not valid UTF-8 or contains NUL bytes; `file.readBytes` returns
   base64 for binary content; `offset`/`length` read large files in ranges.
   Writes are atomic (temp + rename) and accept an opaque `version` guard
   (`VERSION_CONFLICT` on mismatch; full reads/writes carry a content digest,
   list/stat versions are the cheaper `mtime:size` form); `file.stat` supports
   lstat semantics (`follow: false`) for symlink safety. Paths are absolute
   container paths — nothing is confined to the workspace, because the
   container is the isolation boundary.
6. Terminals: `terminal.open` allocates a programmable PTY (persistent `cd`,
   interactive REPLs); output and exit arrive as events keyed by
   `terminalId`.
7. Every request receives exactly one result or error frame, even under
   concurrency; requests that exceed their deadline fail with
   `OPERATION_TIMEOUT`.
8. Failures use stable codes (`CONTAINER_NOT_FOUND`, `CONTAINER_NOT_RUNNING`,
   `OPERATION_TIMEOUT`, `OPERATION_CANCELLED`, `SSH_UNAVAILABLE`,
   `INVALID_REQUEST`, `FS_*`, `VERSION_CONFLICT`, `RUNTIME_ERROR`, …); the full
   table lives in [`PROTOCOL.md`](PROTOCOL.md) §4. Reconnect and retry on
   transport errors; treat `CONTAINER_NOT_FOUND` as terminal.

## 4. Session → container binding

Recommended strategies, in order of precision:

1. **Pin by id** (`containerId`) — the client stores it with its session state.
2. **Reuse or create by name** (`containerName`) — stable across restarts.
3. **Process-scoped default** — a generated name, fine for a one-session
   process.

Rules:

- One client process (or one session) binds to one container. For per-session
  isolation run one process per session; a multi-session host process shares
  one container.
- Containers outlive disconnects: reconnect with the stored id to get the same
  workspace and files.
- The client decides when to create; the server decides when to stop
  (lifecycle policy: idle timeout, max lifetime, delete-after-stop).

## 5. Capability mapping

Goal: the model keeps its native tools and never sees SessionBox-specific
tools. Two supported integration shapes:

### 5.1 Replace the capability providers (headless / custom compositions)

Back the host's filesystem and shell seams with SessionBox implementations:

- Exactly one implementation per seam per context. Disable the built-in
  providers in the composition before inserting the replacement, and pick the
  tool flavor that matches the container (a container is Linux, so the shell
  tool should be the Linux one regardless of the host platform).
- **Constraint**: UI-heavy compositions may have consumers that assume local
  filesystem semantics; replacing the seams there can break unrelated services.
  Prefer headless or custom compositions whose consumers honor provider paths.
- Path mapping: the session's host working directory maps to the container
  workspace (`/workspace`); other container paths pass through unchanged, since
  the container itself is the isolation boundary.

### 5.2 Expose container-backed tools (hosts that cannot replace seams)

When a host cannot swap its capability providers, expose a small tool set that
executes through SessionBox. This is model-visible by nature and therefore a
product decision, not the default.

## 6. Lifecycle and ownership

- A client disconnect never stops or deletes a container (PROJECT.md §39); it
  does stop execs and terminals that were in flight on that connection.
- Open agent or terminal connections count as activity; idle auto-stop only
  applies while no connection is active.
- `deleteAfterStop` removes the container; otherwise it stays `stopped` and can
  be started again.
- Containers are isolated by default (one private network each). Cross-session
  connectivity is opt-in: attach both containers to the same shared network;
  attaching sets a DNS alias equal to the container name.
- Credentials are per-container and sealed server-side; clients never see them.
  Deleting a container removes its credentials.

## 7. Versioning

- `AGENT_PROTOCOL_VERSION` is currently **2**; breaking changes to message
  shapes bump it, and servers reject mismatched clients at the handshake.
- The public container model is runtime-neutral; new fields are additive.

## 8. What a client must never do

- Import a container-runtime SDK (Docker, containerd, …) or assume a specific
  runtime.
- Read container IPs, ports, SSH keys or credentials — they are server-side
  only and never returned by the API.
- Bypass the permission model, or cache tokens in logs.
- Treat a disconnect as a stop, or delete containers it does not own.
