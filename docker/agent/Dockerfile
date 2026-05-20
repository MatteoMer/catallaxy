# Catallaxy agent runtime image.
#
# Runs `pi` with the catallaxy extension as a low-privilege user. The
# host orchestrator always bind-mounts:
#   - the agent's sandbox at /sandbox (rw)
#   - generated pi config at /pi-config (ro)
# In the default dev-server profile it also mounts the host Docker socket when
# available, plus a host-path mirror of the sandbox so docker-compose bind mounts
# work. RPC reaches the orchestrator through CATALLAXY_RPC_ADDR, and model
# egress goes through the authenticated proxy. Upstream API keys are injected
# host-side and are never present in the container env or image.
#
# Multi-arch build (linux/amd64 + linux/arm64) is performed by
# docker/build.sh. The image is content-tagged so changes invalidate
# any cached agent containers.

FROM debian:bookworm-slim

ARG PI_VERSION=0.70.6

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git openssh-client unzip \
        bash build-essential make pkg-config procps jq ripgrep netcat-openbsd \
        python3 python3-pip python3-venv postgresql-client \
        rustc cargo \
 && rm -rf /var/lib/apt/lists/*

# Docker-outside-of-Docker support for dev-server sandboxes. The host
# orchestrator bind-mounts /var/run/docker.sock when available; this installs
# only the client + compose plugin, not a daemon.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*

# Keep /sandbox ergonomics while still making docker-compose bind mounts work
# against the host daemon. The orchestrator also mounts the sandbox at its host
# absolute path and exports CATALLAXY_HOST_SANDBOX; this wrapper cd/re-writes
# /sandbox paths to that mirror before invoking the real Docker CLI.
COPY docker/agent/docker-wrapper.sh /usr/local/bin/docker
RUN mv /usr/bin/docker /usr/bin/docker-real \
 && chmod +x /usr/local/bin/docker

# Install bun (used by the extension at runtime — not by pi itself,
# but useful inside the container if we ever load TS extensions
# directly with bun).
RUN curl -fsSL https://bun.sh/install | bash \
 && mv /root/.bun /opt/bun \
 && ln -s /opt/bun/bin/bun /usr/local/bin/bun

# Install Node.js 20 (required by pi).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Install pi. The same image is used for agents and (optional) sandboxed
# reviews; which prompt/model runs is decided by the spawn args.
RUN npm install -g "@mariozechner/pi-coding-agent@${PI_VERSION}"

# Bundle the catallaxy extension into the image so the container has
# no need to mount the host repo. The bind-mounted /sandbox is the
# only host path the agent ever sees.
RUN mkdir -p /catallaxy/extensions
COPY extensions/catallaxy.ts /catallaxy/extensions/catallaxy.ts

# Create a non-root user that owns nothing on the host.
RUN groupadd -g 1000 catallaxy \
 && useradd -m -u 1000 -g 1000 -s /bin/bash catallaxy \
 && chown -R catallaxy:catallaxy /catallaxy

USER catallaxy:catallaxy
WORKDIR /sandbox

# No CMD: the host orchestrator passes the full pi invocation each run.
