# SessionBox for Pi

Runs Pi's native `bash`, `read`, `write`, `edit` and `ls` tools inside a
SessionBox sandbox. The model keeps the same tool vocabulary; the adapter
re-registers each tool with operations that execute over the SessionBox agent
protocol (`@sessionbox/client`).

Implemented against **`@earendil-works/pi-coding-agent@1.0.2`** (the pluggable
tool operations API: `BashOperations`, `ReadOperations`, `WriteOperations`,
`EditOperations`, `LsOperations`).

## How it works

- `session_start`: resolve the sandbox bound to this Pi session (stored in
  `~/.pi/agent/extensions/sessionbox/bindings.json`) or create one, then open
  an agent-protocol connection.
- Tools: paths under the Pi session cwd map to `/workspace/...`; paths already
  under `/workspace` pass through. Commands and file operations go to the
  sandbox over the agent WebSocket.
- `session_shutdown`: closes the connection only. The sandbox keeps running,
  so a resumed session finds the same workspace (PROJECT.md §39, §43.3).
- Failure is closed: when SessionBox is unreachable the tools report an error
  instead of silently running on the host.

## Usage

```bash
# from a checkout of this repository
pi --extension ./plugins/pi/src/index.ts

# or copy/symlink the directory into the user extensions folder
#   ~/.pi/agent/extensions/sessionbox/
```

Configuration (environment):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSIONBOX_URL` | `http://127.0.0.1:8787` | SessionBox server |
| `SESSIONBOX_TOKEN` | – | bearer token (enforced from Day 6) |
| `SESSIONBOX_SANDBOX` | – | pin every session to one existing sandbox |
| `SESSIONBOX_BINDINGS_FILE` | `~/.pi/agent/extensions/sessionbox/bindings.json` | session → sandbox map |
| `SESSIONBOX_DISABLED` | – | `1` disables the extension |

Flag: `pi --no-sessionbox` runs tools on the host again.

Inside Pi, `/sessionbox` shows the bound sandbox.

## Smoke test without a model

`pnpm --filter @sessionbox/pi-plugin smoke --url http://host:8787` drives the
registered tools directly against a real SessionBox server (no LLM needed) and
prints the results.

## Known limitations

- Image/binary reads are rejected with a clear error; the agent protocol moves
  text only for now.
- In-flight command cancellation (`AbortSignal`) is checked before start, not
  during execution.
- The binding file is written atomically but not locked; two Pi processes
  creating the same session at once can race.
