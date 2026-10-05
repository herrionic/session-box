# SessionBox for DeepSeek Harness (DSH)

Runs DSH's filesystem and shell capabilities inside a SessionBox sandbox. The
harness keeps its native `fs`/`bash` tools and the model sees no new tools; the
`ctx.fs` and `ctx.shell` capability seams are provided by SessionBox.

Implemented against **`deepseek-harness-dsh-v0.2.0-rc.2`** (verified against
the published `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-shell` and
`@deepseek-ai/cordis@4.0.4`).

## Where it plugs in

DSH's `sandbox` seam is *same-host process confinement* (bubblewrap, Landlock,
Seatbelt, Windows ACL); its own docs say remote execution replaces the
**surrounding capability seams** instead. This plugin therefore provides:

| Seam | Provided by | Notes |
| --- | --- | --- |
| `ctx.fs` | `SessionBoxFileSystem` | text operations over the agent protocol (stat/lstat/read/stream/list/write/edit); binary reads are rejected with a typed `FS_IO_ERROR` |
| `ctx.shell` | `SessionBoxShell` | bash in the sandbox with collected output, truncation and timeout classification; `kill()` is a no-op because the protocol is request/response |

## Binding model

DSH's execution world is per harness process (the same model as its SSH
helper), so one DSH process binds one sandbox:

- `sandboxId` pins an existing sandbox;
- `sandboxName` reuses a sandbox with that name (or creates it);
- otherwise a fresh sandbox named `dsh-<pid>` is created on first use.

For per-session isolation run one DSH process per session, which is how the
CLI/headless profiles work. A multi-session host (web/desktop) sharing one
process would share one sandbox — a known limitation.

## Configuration

`cordis.yml` plugin config or environment variables:

| Key / variable | Default | Meaning |
| --- | --- | --- |
| `baseUrl` / `SESSIONBOX_URL` | `http://127.0.0.1:8787` | SessionBox server |
| `token` / `SESSIONBOX_TOKEN` | – | bearer token (enforced from Day 6) |
| `sandboxId` / `SESSIONBOX_SANDBOX` | – | pin an existing sandbox |
| `sandboxName` / `SESSIONBOX_SANDBOX_NAME` | – | reuse/create by name |
| `workspaceRoot` / `SESSIONBOX_WORKSPACE_ROOT` | `/workspace` | sandbox-side root |
| `hostCwd` / `SESSIONBOX_HOST_CWD` | `process.cwd()` | host directory that maps to the workspace |

Example `cordis.yml` entry:

```yaml
plugins:
  '@sessionbox/dsh-plugin':
    baseUrl: http://localhost:8787
    sandboxName: dsh-dev
```

## Smoke test without the harness

`pnpm --filter @sessionbox/dsh-plugin smoke --url http://host:8787` drives the
providers directly against a real server (no model needed) and cleans up the
sandbox it created.

## Known limitations

- Text only: `readBytes` / `readByteRange` throw; `watch` uses the base-class
  rejection.
- `ctx.shell.kill()` reports "already finished"; the protocol timeout is the
  only deadline enforcement.
- The fs version token is `modifiedAt:size`; it is not a cryptographic
  freshness guarantee.
