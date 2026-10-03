# ADR-0002: Deployment model — server container with Docker socket

- Status: accepted
- Date: 2026-10-01
- Owner approval: project owner specified the published image must mount
  `/var/run/docker.sock`

## Context

SessionBox is published as a Docker image. It manages sandbox containers on the
same Docker Engine that runs it, and it must reach those sandboxes over SSH
without publishing their SSH ports (PROJECT.md §21: "SSH port not published to
the host by default").

## Decision

1. The SessionBox server runs as a container with
   `-v /var/run/docker.sock:/var/run/docker.sock` (Docker-outside-of-Docker).
2. The server manages **sibling containers** through the Docker API; sandboxes
   never receive the Docker socket.
3. The server ensures a dedicated bridge network (`sessionbox`, configurable)
   exists and attaches **itself** to it (container hostname = container id).
   `docker-compose.yml` also declares the network, so the attach is a no-op in
   the compose deployment.
4. All sandboxes join that network. The server reaches `containerIP:22`
   directly; nothing is published on the host.
5. Sandboxes run with all capabilities dropped except the minimum sshd needs
   (`AUDIT_WRITE, CHOWN, DAC_OVERRIDE, FOWNER, KILL, NET_BIND_SERVICE, SETGID,
   SETUID, SYS_CHROOT`), `no-new-privileges`, PID/memory/CPU limits, no
   privileged mode and no host mounts.
6. The server container runs as root: the mounted socket already grants
   host-root-equivalent power, and the socket is commonly `root:docker 660`,
   which a non-root container user cannot open. Running the server as root
   does not materially change the trust boundary.

## Consequences

- Positive: no sandbox SSH ports on the host, no TLS certificates for the
  Docker API, one-command deployment (`docker compose up -d`).
- Positive: exactly the topology used in development on the remote host, so
  there is no "works in dev, not in prod" gap.
- Negative: the server container is a highly privileged component. Compromise
  of the server equals host root.
- Negative: sandboxes share one bridge network and can see each other's SSH
  ports (authentication still requires per-sandbox keys). Per-sandbox networks
  are a possible later hardening step.
- Documented limitation: Docker isolation here is an agent-workspace boundary,
  not hardened adversarial isolation (PROJECT.md §21).

## Alternatives considered

1. **Publish SSH ports on the host** — rejected by PROJECT.md §21.
2. **Docker socket proxy (e.g. tecnativa/docker-socket-proxy)** — safer, but an
   extra component with its own allow-list tuning; not justified for the MVP.
3. **Remote Docker over TLS with the server running outside** — rejected: the
   server then cannot reach sandbox container IPs, which breaks SSH/SFTP/PTY.
4. **Rootless Docker / Podman** — possible future runtime profile; out of MVP
   scope.
