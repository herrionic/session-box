# SessionBox container base image.
#
# - non-root "agent" user for all agent and human work
# - sshd is the only service; it starts as root and drops to "agent" per session
# - SessionBox (never the plugin) injects an ephemeral public key at container
#   create time via SESSIONBOX_AUTHORIZED_KEY
# - no Docker socket, no published ports: the server reaches this container
#   over the shared "sessionbox" bridge network
#
# Build:  docker build -t sessionbox/base:latest images/base
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      less \
      openssh-server \
      procps \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Non-root user that agent sessions log in as. The random password only serves
# to unlock the account for sshd's account check; password authentication is
# disabled in sshd-sessionbox.conf and the password is never disclosed.
RUN useradd --create-home --shell /bin/bash --uid 1000 agent \
 && echo "agent:$(head -c 24 /dev/urandom | base64)" | chpasswd \
 && mkdir -p /workspace \
 && chown agent:agent /workspace

# Key-only authentication, no root login, no PAM (keeps the capability set small).
COPY sshd-sessionbox.conf /etc/ssh/sshd_config.d/100-sessionbox.conf

# Fail the build if the sshd configuration is broken. Host keys are generated
# for validation only and removed again so every container gets unique ones.
RUN mkdir -p /run/sshd \
 && ssh-keygen -A \
 && sshd -t \
 && rm -f /etc/ssh/ssh_host_*

COPY entrypoint.sh /usr/local/bin/sessionbox-entrypoint
RUN chmod +x /usr/local/bin/sessionbox-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sessionbox-entrypoint"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
