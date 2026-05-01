# Catallaxy agent runtime image.
#
# Runs `pi` with the catallaxy extension as a low-privilege user. The
# host orchestrator bind-mounts:
#   - the agent's sandbox at /sandbox (rw)
#   - the agent's RPC socket at /run/catallaxy.sock
# and exposes OpenRouter via an HTTP proxy on host.docker.internal —
# never as an env var. No secrets are baked into this image.
#
# Multi-arch build (linux/amd64 + linux/arm64) is performed by
# docker/build.sh. The image is content-tagged so changes invalidate
# any cached agent containers.

FROM debian:bookworm-slim

ARG PI_VERSION=0.70.6

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl git python3 python3-pip unzip \
 && rm -rf /var/lib/apt/lists/*

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

# Install pi (agents) and claude-code (reviewer) as global npm
# packages. The same image is used for both — which binary runs is
# decided by the spawn args. Keeping one image avoids drift between
# the agent's and reviewer's isolation profile.
ARG CLAUDE_VERSION=2.1.126
RUN npm install -g \
    "@mariozechner/pi-coding-agent@${PI_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_VERSION}"

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
