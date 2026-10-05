# SessionBox Protocol

Two surfaces, one contract (`packages/protocol`, zod-validated at every
boundary):

- **REST** — container management and the human file manager.
- **Agent WebSocket** — what harness plugins use for session-scoped execution,
  files and terminals.
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
`FS_NOT_TEXT`; use download for binary content. File writes are atomic
(same-directory temp file + rename), so readers never observe a partial file.

Errors always use the stable envelope; codes are listed in §4:

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
{ "type": "exec",          "requestId": "r1", "containerId": "ctr_...", "command": "ls", "cwd": "/workspace", "timeoutMs": 30000 }
{ "type": "exec.cancel",   "requestId": "r1c", "containerId": "ctr_...", "targetRequestId": "r1" }
{ "type": "file.read",     "requestId": "r2", "containerId": "ctr_...", "path": "/workspace/a.txt", "offset": 0, "length": 65536 }
{ "type": "file.readBytes","requestId": "r2b", "containerId": "ctr_...", "path": "/workspace/a.bin", "maxBytes": 8388608 }
{ "type": "file.write",    "requestId": "r3", "containerId": "ctr_...", "path": "/workspace/a.txt", "content": "hi", "expected": { "version": "49f68a5c8493ec2c0bf489821c21fc3b" } }
{ "type": "file.rename",   "requestId": "r3b", "containerId": "ctr_...", "from": "/workspace/a.txt", "to": "/workspace/b.txt", "overwrite": false }
{ "type": "file.chmod",    "requestId": "r3c", "containerId": "ctr_...", "path": "/workspace/a.txt", "mode": 420 }
{ "type": "file.symlink",  "requestId": "r3d", "containerId": "ctr_...", "path": "/workspace/link", "target": "/workspace/a.txt" }
{ "type": "file.list",     "requestId": "r4", "containerId": "ctr_...", "path": "/workspace" }
{ "type": "file.stat",     "requestId": "r5", "containerId": "ctr_...", "path": "/workspace/link", "follow": false }
{ "type": "file.mkdir",    "requestId": "r6", "containerId": "ctr_...", "path": "/workspace/x", "recursive": true }
{ "type": "file.remove",   "requestId": "r7", "containerId": "ctr_...", "path": "/workspace/x", "recursive": true }
{ "type": "terminal.open", "requestId": "r8", "containerId": "ctr_...", "cols": 80, "rows": 24, "term": "xterm-256color" }
```

One-way control frames (no response, no `requestId`):

```jsonc
{ "type": "terminal.input",  "terminalId": "term_...", "data": "ls\r" }
{ "type": "terminal.resize", "terminalId": "term_...", "cols": 120, "rows": 30 }
{ "type": "terminal.close",  "terminalId": "term_..." }
```

`EDIT` is intentionally absent: harness adapters implement it with
read/write/stat, preserving their native semantics.

### Responses and events

```jsonc
{ "type": "exec.result",       "requestId": "r1", "exitCode": 0, "stdout": "...", "stderr": "" }
{ "type": "exec.stdout",       "requestId": "r1", "data": "..." }        // preview while running
{ "type": "exec.stderr",       "requestId": "r1", "data": "..." }        // preview while running
{ "type": "exec.cancel.result","requestId": "r1c", "targetRequestId": "r1" }
{ "type": "file.read.result",  "requestId": "r2", "file": { "path": "...", "content": "hi", "size": 2, "modifiedAt": 0, "version": "49f68a5c8493ec2c0bf489821c21fc3b", "offset": 0, "length": 2, "eof": true } }
{ "type": "file.readBytes.result", "requestId": "r2b", "file": { "path": "...", "contentBase64": "AAEC", "size": 3, "modifiedAt": 0, "version": "900150983cd24fb0d6963f7d28e17f72" } }
{ "type": "file.write.result", "requestId": "r3", "file": { "path": "...", "size": 2, "modifiedAt": 0, "version": "49f68a5c8493ec2c0bf489821c21fc3b" } }
{ "type": "file.rename.result","requestId": "r3b", "from": "...", "to": "..." }
{ "type": "file.chmod.result", "requestId": "r3c", "path": "...", "mode": 420 }
{ "type": "file.symlink.result","requestId": "r3d", "path": "...", "target": "..." }
{ "type": "file.list.result",  "requestId": "r4", "path": "/workspace", "entries": [ /* FileEntry */ ] }
{ "type": "file.stat.result",  "requestId": "r5", "entry": { /* FileEntry */ } }
{ "type": "file.mkdir.result", "requestId": "r6", "path": "/workspace/x" }
{ "type": "file.remove.result","requestId": "r7", "path": "/workspace/x" }
{ "type": "terminal.opened",   "requestId": "r8", "terminalId": "term_..." }
{ "type": "terminal.output",   "terminalId": "term_...", "data": "..." }
{ "type": "terminal.exit",     "terminalId": "term_...", "code": 0 }
{ "type": "error",             "requestId": "r1", "code": "CONTAINER_NOT_RUNNING", "message": "..." }
```

`FileEntry` is `{ name, path, type, size, mode, modifiedAt, version,
linkTarget? }`.

### Semantics

- **Paths**: absolute container paths, not confined to the workspace — the
  container is the isolation boundary. Relative paths and NUL bytes are
  rejected (`INVALID_REQUEST`).
- **Binary safety**: `file.read` returns text only; a full read that is not
  valid UTF-8 or contains NUL bytes fails with `FS_NOT_TEXT` (never silently
  mangled). `file.readBytes` returns base64 for binary content; its optional
  `maxBytes` rejects larger files early (`FS_TOO_LARGE`).
- **Versions**: `version` is the MD5 of the resource itself — file content,
  symlink target, or a stat descriptor for directories and special files — so
  every surface (read, write, stat, list) reports the same value for the same
  state. MD5 is chosen for speed because listing recomputes versions; files
  are read to hash them, so very large files make listing slower.
- **Atomic writes**: `file.write` writes a same-directory temp file and
  renames it over the target. With `expected`, a mismatch fails with
  `VERSION_CONFLICT` and `details.current` (the observed version, or `null`
  when the file does not exist).
- **lstat**: `file.stat` follows symlinks by default; `follow: false` behaves
  like lstat and fills `linkTarget` for symlinks (dangling links included).
- **Range reads**: `file.read` accepts `offset`/`length` (0-based bytes) for
  files larger than the 8 MiB message limit; the result reports the actual
  `offset`, `length` and `eof`. A ranged chunk may split a multi-byte UTF-8
  sequence at its tail; full reads are validated strictly.
- **Cancellation**: `exec.cancel` targets the `requestId` of an in-flight
  `exec` on the same connection, kills the command's whole process group and
  answers the target with `OPERATION_CANCELLED`. Unknown or finished targets
  are `INVALID_REQUEST`. The cancel message itself is answered by
  `exec.cancel.result`.
- **Streaming**: `exec.stdout`/`exec.stderr` are preview frames; the terminal
  response is always `exec.result` with the complete output.
- **Terminals**: `terminal.open` allocates a PTY; input/resize/close are
  one-way frames, output/exit are events. `terminal.exit` reports shells that
  end on their own; an explicit `terminal.close` needs no exit event.
  Terminals die with the connection; the container keeps running.
- **Exactly one terminal response**: every request receives exactly one
  result or error frame, even under concurrency. A request that exceeds its
  deadline (`timeoutMs` for exec, 60 s for file and terminal operations) is
  answered with `OPERATION_TIMEOUT`.
- **Limits**: 8 MiB per file payload. Exec commands and timeouts default to
  1 MiB / 30 min and are configurable per deployment
  (`SESSIONBOX_MAX_EXEC_COMMAND_BYTES`, `SESSIONBOX_MAX_EXEC_TIMEOUT_MS`);
  the wire caps are 4 MiB / 4 h.
- **Connection lifetime ≠ container lifetime**: closing the socket only ends
  temporary access; it never stops or deletes a container (PROJECT.md §39).
  Reconnecting with the same `containerId` returns to the same `/workspace`.
  In-flight execs and terminals are stopped when the connection closes.

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

## 4. Error codes

| Code | Meaning | HTTP |
| --- | --- | --- |
| `CONTAINER_NOT_FOUND` | no managed container has this id | 404 |
| `CONTAINER_NOT_RUNNING` | the lifecycle state forbids the operation | 409 |
| `CONTAINER_CREATE_FAILED` | the runtime could not create the container | 502 |
| `SSH_UNAVAILABLE` | the container SSH endpoint is unreachable | 503 |
| `UNAUTHORIZED` | missing or unknown credentials | 401 |
| `FORBIDDEN` | the principal lacks the required permission | 403 |
| `INVALID_REQUEST` | malformed, unsupported or out-of-range input | 400 |
| `INVALID_STATE` | the operation conflicts with current state | 409 |
| `OPERATION_TIMEOUT` | the operation exceeded its deadline | 504 |
| `OPERATION_CANCELLED` | the exec was cancelled by the client | 499 |
| `NOT_FOUND` | the path does not exist | 404 |
| `FS_NOT_TEXT` | not valid UTF-8 text (or contains NUL bytes) | 400 |
| `FS_TOO_LARGE` | exceeds a transfer or text limit | 413 |
| `FS_IS_DIRECTORY` | a directory was used where a file is required | 400 |
| `FS_NOT_REGULAR_FILE` | not a regular file (socket, device, …) | 400 |
| `FS_PERMISSION_DENIED` | the `agent` user may not perform this | 403 |
| `VERSION_CONFLICT` | `expected.version` does not match the file | 409 |
| `RUNTIME_ERROR` | unclassified failure; `details.reason` is machine-readable | 502 |
| `INTERNAL_ERROR` | a server bug; details stay in the logs | 500 |

## 5. Versioning

`AGENT_PROTOCOL_VERSION = 2`. The server rejects other versions during the
handshake; no negotiation beyond that is planned for the MVP. New messages and
optional fields are additive within a version.
