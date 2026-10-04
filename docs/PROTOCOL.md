# SessionBox Protocol

Two surfaces, one contract (`packages/protocol`, zod-validated at every
boundary):

- **REST** — sandbox management and the human file manager.
- **Agent WebSocket** — what harness plugins use for session-scoped execution.
- **Terminal WebSocket** — browser-only (xterm.js ↔ SSH PTY).

Harness plugins never see SSH, Docker, container IPs or credentials. They use
`packages/client` (`SessionBoxClient`), which speaks the surfaces below.

## 1. REST

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness, runtime id, uptime |
| GET | `/api/sandboxes` | list sandboxes |
| POST | `/api/sandboxes` | create (name/image/resources/lifecycle) |
| GET | `/api/sandboxes/:id` | get one |
| POST | `/api/sandboxes/:id/start` \| `stop` \| `restart` | lifecycle |
| DELETE | `/api/sandboxes/:id` | delete (container + credentials) |
| PATCH | `/api/sandboxes/:id/settings` | rename, lifecycle policy |
| GET | `/api/sandboxes/:id/logs` | container logs (`?tail=`) |
| GET | `/api/sandboxes/:id/files` | list directory (`?path=`) |
| GET/PUT | `/api/sandboxes/:id/files/content` | read/write text (`?path=`, JSON body) |
| POST | `/api/sandboxes/:id/files` | create file/directory (`{path, type}`) |
| DELETE | `/api/sandboxes/:id/files` | delete (`?path=&recursive=`) |
| POST | `/api/sandboxes/:id/files/upload` | raw `application/octet-stream` body |
| GET | `/api/sandboxes/:id/files/download` | raw bytes |

File-manager paths are **confined to the workspace root** (`/workspace` by
default); traversal attempts are rejected before any SSH call. Text editing is
limited to 1 MiB, uploads/downloads to 16 MiB.

Errors always use the stable envelope:

```json
{ "error": { "code": "SANDBOX_NOT_FOUND", "message": "...", "requestId": "req_..." } }
```

## 2. Agent WebSocket — `WS /api/ws/agent`

### Handshake (protocol version 1)

```jsonc
// client → server
{ "type": "hello", "protocolVersion": 1, "client": "dsh-plugin" }
// server → client
{ "type": "welcome", "protocolVersion": 1 }
```

A wrong version or a missing handshake (10 s timeout) closes the connection
with an `error` message.

### Requests

Every request carries `requestId` (client-chosen, echoed back) and
`sandboxId`; one connection may serve several sandboxes.

```jsonc
{ "type": "exec",        "requestId": "r1", "sandboxId": "sbx_...", "command": "ls", "cwd": "/workspace", "timeoutMs": 30000 }
{ "type": "file.read",   "requestId": "r2", "sandboxId": "sbx_...", "path": "/workspace/a.txt" }
{ "type": "file.write",  "requestId": "r3", "sandboxId": "sbx_...", "path": "/workspace/a.txt", "content": "hi" }
{ "type": "file.list",   "requestId": "r4", "sandboxId": "sbx_...", "path": "/workspace" }
{ "type": "file.stat",   "requestId": "r5", "sandboxId": "sbx_...", "path": "/workspace/a.txt" }
{ "type": "file.mkdir",  "requestId": "r6", "sandboxId": "sbx_...", "path": "/workspace/x", "recursive": true }
{ "type": "file.remove", "requestId": "r7", "sandboxId": "sbx_...", "path": "/workspace/x", "recursive": true }
```

`EDIT` is intentionally absent: harness adapters implement it with
read/write/stat, preserving their native semantics.

### Responses

```jsonc
{ "type": "exec.result",       "requestId": "r1", "exitCode": 0, "stdout": "...", "stderr": "" }
{ "type": "file.read.result",  "requestId": "r2", "file": { "path": "...", "content": "...", "size": 2, "modifiedAt": 0 } }
{ "type": "file.write.result", "requestId": "r3", "file": { "path": "...", "size": 2, "modifiedAt": 0 } }
{ "type": "file.list.result",  "requestId": "r4", "path": "/workspace", "entries": [ /* FileEntry */ ] }
{ "type": "file.stat.result",  "requestId": "r5", "entry": { /* FileEntry */ } }
{ "type": "file.mkdir.result", "requestId": "r6", "path": "/workspace/x" }
{ "type": "file.remove.result","requestId": "r7", "path": "/workspace/x" }
{ "type": "error",             "requestId": "r1", "code": "SANDBOX_NOT_RUNNING", "message": "..." }
```

### Semantics

- **Paths**: agent paths must be absolute and are not confined to the
  workspace — the SSH user's permissions are the boundary. Relative paths and
  NUL bytes are rejected (`INVALID_REQUEST`).
- **Connection lifetime ≠ sandbox lifetime**: closing the socket only ends
  temporary access; it never stops or deletes a sandbox (PROJECT.md §39).
  Reconnecting with the same `sandboxId` returns to the same `/workspace`.
- **Limits**: 8 MiB per file payload, 64 KiB per command, 10 min per exec.
- **Errors**: stable codes only; details stay in the server log.

## 3. Terminal WebSocket — `WS /api/ws/terminal/:sandboxId`

Browser-only. `?cols=&rows=` sets the initial PTY size.

```jsonc
// client → server
{ "type": "input",  "data": "ls\r" }
{ "type": "resize", "cols": 120, "rows": 30 }
// server → client
{ "type": "ready",  "sandboxId": "sbx_..." }
{ "type": "output", "data": "..." }
{ "type": "exit",   "code": 0 }
{ "type": "error",  "code": "SANDBOX_NOT_RUNNING", "message": "..." }
```

## 4. Versioning

`AGENT_PROTOCOL_VERSION = 1`. The server rejects other versions during the
handshake; no negotiation beyond that is planned for the MVP.
