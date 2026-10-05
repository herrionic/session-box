# SessionBox Integration Protocol

How an agent harness (or any client) connects to a SessionBox service. This
document is the integration contract: authentication, session → container
binding, capability mapping, lifecycle ownership and failure semantics.
Wire-level message schemas live in [`PROTOCOL.md`](PROTOCOL.md).

```text
harness process ──REST + WebSocket──▶ SessionBox server ──SSH (per-container key)──▶ container
                                            │
                                            └── Docker socket (server-side only)
```

- The adapter speaks only the public API. Containers are addressed by their
  public id; container IPs, ports, SSH keys and Docker handles never leave the
  server.
- The server owns container lifecycle; the adapter owns session lifecycle. A
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
2. Requests are validated and correlated by `requestId`; one connection
   multiplexes every operation for the bound container.
3. Operations: `exec`, `file.read`, `file.write`, `file.list`, `file.stat`,
   `file.mkdir`, `file.remove` — exact shapes in [`PROTOCOL.md`](PROTOCOL.md) §2.
4. `exec` carries `command`, optional `cwd` and `timeoutMs`, and runs through a
   real SSH channel as the non-root `agent` user (uid 1000) inside the
   container.
5. The file protocol is text-only today; binary reads fail with a typed
   `FS_IO_ERROR`.
6. Failures use stable codes (`CONTAINER_NOT_FOUND`, `CONTAINER_NOT_RUNNING`,
   `OPERATION_TIMEOUT`, `SSH_UNAVAILABLE`, `INVALID_REQUEST`, `RUNTIME_ERROR`,
   …). Reconnect and retry on transport errors; treat `CONTAINER_NOT_FOUND` as
   terminal.

## 4. Session → container binding

Recommended strategies, in order of precision:

1. **Pin by id** (`containerId`) — the adapter stores it with its session state.
2. **Reuse or create by name** (`containerName`) — stable across restarts.
3. **Process-scoped default** (e.g. `dsh-<pid>`) — fine for a one-session CLI.

Rules:

- One harness process (or one session) binds to one container. For per-session
  isolation run one process per session; a multi-session host process shares
  one container (documented limitation of the DSH adapter).
- Containers outlive disconnects: reconnect with the stored id to get the same
  workspace and files.
- The adapter decides when to create; the server decides when to stop
  (lifecycle policy: idle timeout, max lifetime, delete-after-stop).

## 5. Capability mapping

Goal: the model keeps its native tools and never sees SessionBox-specific
tools. Two supported integration shapes:

### 5.1 Replace the capability providers (headless / custom compositions)

Back the harness's filesystem and shell seams with SessionBox implementations:

- Exactly one implementation per seam per context. Disable the built-in
  providers in the composition before inserting yours — for DSH:
  `fs-sandbox`, `bash-sandbox`, `pwsh-sandbox`; because the container is
  Linux, also enable `tool-bash` and disable `tool-pwsh` on Windows hosts.
- **Constraint**: Web/desktop compositions have consumers that assume host
  filesystem access; replacing the seams there breaks session creation
  (`sessionController` unavailable). Use headless/CLI profiles or a custom
  composition whose consumers honor provider paths.
- Path mapping: the session's host working directory maps to the container
  workspace (`/workspace`); paths outside fail closed. Shared helper:
  `@sessionbox/shared` (`container-paths`).
- Reference implementations: `plugins/dsh` (DSH bundle) and `plugins/pi`
  (Pi extension re-registering the native tools).

### 5.2 Expose container-backed tools (hosts that cannot replace seams)

When a host cannot swap its capability providers (for example the DSH
desktop/Web composition), expose a small tool set that executes through
SessionBox. This is model-visible by nature and therefore a product decision,
not the default.

## 6. Lifecycle and ownership

- A plugin disconnect never stops or deletes a container (PROJECT.md §39).
- Open agent or terminal connections count as activity; idle auto-stop only
  applies while no connection is active.
- `deleteAfterStop` removes the container; otherwise it stays `stopped` and can
  be started again.
- Containers are isolated by default (one private network each). Cross-session
  connectivity is opt-in: attach both containers to the same shared network;
  attaching sets a DNS alias equal to the container name.
- Credentials are per-container and sealed server-side; adapters never see
  them. Deleting a container removes its credentials.

## 7. Minimal example (`@sessionbox/client`)

```ts
import { SessionBoxClient } from "@sessionbox/client";

const client = new SessionBoxClient({ baseUrl, token });

// Reuse or create by name (see §4).
const existing = (await client.listContainers()).find((c) => c.name === "my-session");
const container = existing ?? (await client.createContainer({ name: "my-session" }));

const runtime = await client.connect(container.id);
await runtime.exec("pwd && id", { timeoutMs: 10_000 });
const file = await runtime.readFile("/workspace/README.md");
await runtime.writeFile("/workspace/note.txt", "hello from the session\n");
await runtime.close(); // ends the connection, never the container
```

- `SessionBoxClient`: `health`, `listContainers`, `createContainer`,
  `getContainer`, `startContainer`, `stopContainer`, `restartContainer`,
  `deleteContainer`, `updateContainerSettings`, `connect`.
- `ContainerRuntime`: `exec`, `readFile`, `writeFile`, `listFiles`,
  `statFile`, `mkdir`, `remove`, `close`.

## 8. Versioning

- `AGENT_PROTOCOL_VERSION` is currently **2**; breaking changes to message
  shapes bump it, and servers reject mismatched clients at the handshake.
- The public container model is runtime-neutral; new fields are additive.

## 9. What an adapter must never do

- Import a container-runtime SDK (Docker, containerd, …) or assume Docker.
- Read container IPs, ports, SSH keys or credentials — they are server-side
  only and never returned by the API.
- Bypass the permission model, or cache tokens in logs.
- Treat a disconnect as a stop, or delete containers it does not own.
