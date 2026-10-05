# ADR-0003 — Passwordless sudo inside containers

- Status: accepted
- Date: 2026-10-05
- Amends: ADR-0002 (container capability set)

## Context

Coding agents routinely need system-level changes inside their execution
environment: `apt-get install` for native dependencies, global tool installs,
edits under `/etc`. The MVP ran every session as the non-root `agent` user and
set `no-new-privileges`, which makes those operations impossible: `sudo` is a
setuid binary and `no-new-privileges` blocks the privilege transition outright.

The container is explicitly a development / agent-environment boundary, not
hostile-code isolation (PROJECT.md §21). Devcontainers and Codespaces use
passwordless sudo for exactly this reason.

## Decision

- The `agent` user gets passwordless sudo (`/etc/sudoers.d/agent`,
  `agent ALL=(ALL) NOPASSWD:ALL`) and the base image ships `sudo`.
- `no-new-privileges` is removed from the Docker host config, because it
  blocks setuid elevation entirely.
- Everything else stays as decided in ADR-0002: `CapDrop: ALL` plus the minimal
  sshd capability set (`AUDIT_WRITE, CHOWN, DAC_OVERRIDE, FOWNER, KILL,
  NET_BIND_SERVICE, SETGID, SETUID, SYS_CHROOT`), no Docker socket, no host
  mounts, private bridge network, PID/memory/CPU limits, no published ports.

## Consequences

- Container-root is bounded by the dropped capability set: no `SYS_ADMIN`,
  `NET_ADMIN`, `SYS_PTRACE`, `SYS_MODULE`, so mounting filesystems,
  reconfiguring the network or kernel-level operations stay impossible even
  after `sudo`.
- The default session identity remains non-root; elevation is explicit and
  visible in the command line.
- A compromised agent process can become container-root and modify the
  container's own filesystem (including its sshd configuration). This is
  accepted for a development environment and must not be presented as
  hardened adversarial-code isolation.
