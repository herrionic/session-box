# SessionBox Protocol

Two surfaces, one contract (`packages/protocol`, zod-validated at every
boundary):

- **REST** — container management and the human file manager.
- **Agent WebSocket** — what harness plugins use for session-scoped execution.
- **Terminal WebSocket** — browser-only (xterm.js ↔ SSH PTY).

Harness plugins never see SSH, Docker, container IPs or credentials. They use
`packages/client` (`SessionBoxClient`), which speaks the surfaces below.

## 1. REST

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness, runtime id, uptime |
| GET | `/api/containers` | list containers |
| POST | `/api/containers` | create (name/image/resources/lifecycle) |
| GET | `/api/containers/:id` | get one |
| POST | `/api/containers/:id/start` \| `stop` \| `restart` | lifecycle |
| DELETE | `/api/containers/:id` | delete (container + credentials) |
| PATCH | `/api/containers/:id/settings` | rename, lifecycle policy |
| GET | `/api/containers/:id/logs` | container logs (`?tail=`) |
| GET | `/api/containers/:id/files` | list directory (`?path=`) |
| GET/PUT | `/api/containers/:id/files/content` | read/write text (`?path=`, JSON body) |
| POST | `/api/containers/:id/files` | create file/directory (`{path, type}`) |
| DELETE | `/api/containers/:id/files` | delete (`?path=&recursive=`) |
| POST | `/api/containers/:id/files/upload` | raw `application/octet-stream` body |
| GET | `/api/containers/:id/files/download` | raw bytes |

File-manager paths are absolute container paths; nothing is confined to the
workspace — the container is the isolation boundary, so the manager can browse
the whole filesystem. Text editing is limited to 1 MiB, uploads/downloads to
16 MiB. Reading a non-UTF-8 (or NUL-containing) file as text fails with
`FS_NOT_TEXT`; use download for binary content.

Errors always use the stable envelope:

```json
{ "error": { "code": "CONTAINER_NOT_FOUND", "message": "...", "requestId": "req_..." } }
```

## 2. Agent WebSocket — `WS /api/ws/agent`

### Handshake (protocol version 2)

```jsonc
// client → server
{ "type": "hello", "protocolVersion": 2, "client": "dsh-plugin" }
// server → client
{ "type": "welcome", "protocolVersion": 2 }
```

A wrong version or a missing handshake (10 s timeout) closes the connection
with an `error` message.

### Requests

Every request carries `requestId` (client-chosen, echoed back) and
`containerId`; one connection may serve several containers.

```jsonc
{ "type": "exec",        "requestId": "r1", "containerId": "ctr_...", "command": "ls", "cwd": "/workspace", "timeoutMs": 30000 }
{ "type": "exec.cancel", "requestId": "r1c", "containerId": "ctr_...", "targetRequestId": "r1" }
{ "type": "file.read",   "requestId": "r2", "containerId": "ctr_...", "path": "/workspace/a.txt" }
{ "type": "file.readBytes", "requestId": "r2b", "containerId": "ctr_...", "path": "/workspace/a.bin" }
{ "type": "file.write",  "requestId": "r3", "containerId": "ctr_...", "path": "/workspace/a.txt", "content": "hi" }
{ "type": "file.list",   "requestId": "r4", "containerId": "ctr_...", "path": "/workspace" }
{ "type": "file.stat",   "requestId": "r5", "containerId": "ctr_...", "path": "/workspace/a.txt" }
{ "type": "file.mkdir",  "requestId": "r6", "containerId": "ctr_...", "path": "/workspace/x", "recursive": true }
{ "type": "file.remove", "requestId": "r7", "containerId": "ctr_...", "path": "/workspace/x", "recursive": true }
```

`EDIT` is intentionally absent: harness adapters implement it with
read/write/stat, preserving their native semantics.

### Responses

```jsonc
{ "type": "exec.result",       "requestId": "r1", "exitCode": 0, "stdout": "...", "stderr": "" }
{ "type": "exec.cancel.result","requestId": "r1c", "targetRequestId": "r1" }
{ "type": "file.read.result",  "requestId": "r2", "file": { "path": "...", "content": "...", "size": 2, "modifiedAt": 0 } }
{ "type": "file.readBytes.result", "requestId": "r2b", "file": { "path": "...", "contentBase64": "AAEC", "size": 3, "modifiedAt": 0 } }
{ "type": "file.write.result", "requestId": "r3", "file": { "path": "...", "size": 2, "modifiedAt": 0 } }
{ "type": "file.list.result",  "requestId": "r4", "path": "/workspace", "entries": [ /* FileEntry */ ] }
{ "type": "file.stat.result",  "requestId": "r5", "entry": { /* FileEntry */ } }
{ "type": "file.mkdir.result", "requestId": "r6", "path": "/workspace/x" }
{ "type": "file.remove.result","requestId": "r7", "path": "/workspace/x" }
{ "type": "error",             "requestId": "r1", "code": "CONTAINER_NOT_RUNNING", "message": "..." }
```

### Semantics

- **Paths**: agent paths must be absolute and are not confined to the
  workspace — the SSH user's permissions are the boundary. Relative paths and
  NUL bytes are rejected (`INVALID_REQUEST`).
- **Binary safety**: `file.read` returns text only; a file that is not valid
  UTF-8 or contains NUL bytes fails with `FS_NOT_TEXT` (never silently
  mangled). `file.readBytes` returns base64 for binary content.
- **Cancellation**: `exec.cancel` targets the `requestId` of an in-flight
  `exec` on the same connection, kills the command's whole process group and
  answers the target with `OPERATION_CANCELLED`. Unknown or finished targets
  are `INVALID_REQUEST`. The cancel message itself is answered by
  `exec.cancel.result`.
- **Exactly one terminal response**: every request receives exactly one
  result or error frame, even under concurrency. A request that exceeds its
  deadline (`timeoutMs` for exec, 60 s for file operations) is answered with
  `OPERATION_TIMEOUT`.
- **Connection lifetime ≠ container lifetime**: closing the socket only ends
  temporary access; it never stops or deletes a container (PROJECT.md §39).
  Reconnecting with the same `containerId` returns to the same `/workspace`.
  In-flight execs are cancelled when the connection closes.
- **Limits**: 8 MiB per file payload, 64 KiB per command, 10 min per exec.
- **Errors**: stable codes only; details stay in the server log.

## 3. Terminal WebSocket — `WS /api/ws/terminal/:containerId`

Browser-only. `?cols=&rows=` sets the initial PTY size.

```jsonc
// client → server
{ "type": "input",  "data": "ls\r" }
{ "type": "resize", "cols": 120, "rows": 30 }
// server → client
{ "type": "ready",  "containerId": "ctr_..." }
{ "type": "output", "data": "..." }
{ "type": "exit",   "code": 0 }
{ "type": "error",  "code": "CONTAINER_NOT_RUNNING", "message": "..." }
```

## 4. Versioning

`AGENT_PROTOCOL_VERSION = 2`. The server rejects other versions during the
handshake; no negotiation beyond that is planned for the MVP.
