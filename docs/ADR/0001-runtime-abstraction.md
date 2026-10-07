# ADR-0001: Runtime abstraction boundary

- Status: accepted
- Date: 2026-10-01
- Owner approval: requested by the project owner ("设计上支持更换容器运行时")

## Context

SessionBox is specified against Docker, but the MVP should not paint itself
into a corner: containerd, Kubernetes and WSLc may become relevant in later
phases. At the same time the MVP keeps those runtimes out, and speculative
abstractions stay forbidden until a second real use case exists.

The hard part of a runtime swap is not `create`/`delete`; it is **access**.
The server needs SSH/SFTP/PTY into a container:

- Docker (same Linux host): dial the container IP on the shared bridge;
- Kubernetes: `pods/exec` or `port-forward` streams;
- WSLc: likely exec streams / host port mappings, and there is no Node
  binding for the (preview) WSL container API.

## Decision

Reserve a **thin internal seam**, implement only Docker now:

1. `apps/server/src/runtime/types.ts` defines `ContainerRuntime`
   (lifecycle + `openPortStream`) with runtime-neutral types.
2. `dockerode` is imported **only** under `apps/server/src/runtime/docker/`;
   adapter internals (labels, capabilities, network, container IPs, log
   framing) never leak out.
3. The SSH/SFTP/terminal layer will consume `openPortStream()` (an ssh2
   custom transport), so access-strategy differences stay inside the adapter.
4. The public model and protocol stay runtime-neutral; persistence stores
   `runtime` + an opaque `runtime_ref`.
5. `FakeRuntime` in the server test suite proves the interface is
   implementable without Docker.

Deliberately **not** done: no Kubernetes/containerd/WSLc code, no scheduler,
no CRD, no multi-node placement, no runtime plugin-loading framework, no
runtime selection in the public API (MVP is fixed to `SESSIONBOX_RUNTIME=docker`).

## Consequences

- Positive: a future runtime is one adapter directory plus one factory branch;
  core logic is tested against an interface, not dockerode.
- Positive: the access boundary is explicit — the risky part of a runtime swap
  is designed, not discovered.
- Negative: one extra indirection layer in the server.
- Risk: if a future runtime cannot expose a raw TCP stream, its adapter still
  needs an exec-based access path (tar-over-exec for files, exec PTY for
  terminals). That extension is intentionally deferred until the second
  runtime exists.

## Alternatives considered

1. **No abstraction** — direct dockerode calls everywhere. Rejected: cheap
   today, expensive to unwind; contradicting the owner's request.
2. **Full provider plugin framework now** — rejected as speculative
   architecture with only one implementation.
3. **Separate runtime service (out-of-process)** — rejected: microservice
   scope creep, against the MVP scope and the ADR-first rule.
