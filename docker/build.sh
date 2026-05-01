#!/usr/bin/env bash
# Build the catallaxy agent image for both linux/amd64 and linux/arm64.
#
# Usage:
#   docker/build.sh                      # builds catallaxy-agent:dev locally
#   docker/build.sh --push                # builds + pushes to registry
#
# The tag is "{pi_version}-{git_sha}" to make stale agent containers
# detectable; an alias "latest" points to the most recent build.

set -euo pipefail

cd "$(dirname "$0")/.."

PI_VERSION="${PI_VERSION:-$(node -e "console.log(require('/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/package.json').version)" 2>/dev/null || echo "0.70.6")}"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
TAG="${PI_VERSION}-${GIT_SHA}"

PUSH=""
if [[ "${1:-}" == "--push" ]]; then
  PUSH="--push"
fi

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

# buildx is required for multi-arch. Fall back to single-arch local
# build if buildx isn't available — useful in dev.
if docker buildx version >/dev/null 2>&1; then
  if [[ -n "$PUSH" ]]; then
    docker buildx build \
      --platform "$PLATFORMS" \
      --build-arg "PI_VERSION=$PI_VERSION" \
      -f docker/agent/Dockerfile \
      -t "catallaxy-agent:${TAG}" \
      -t "catallaxy-agent:latest" \
      $PUSH \
      .
  else
    # buildx multi-platform without --push needs --output=type=oci or a
    # registry; for local dev just build for the current platform and
    # load into the daemon.
    docker buildx build \
      --build-arg "PI_VERSION=$PI_VERSION" \
      -f docker/agent/Dockerfile \
      -t "catallaxy-agent:${TAG}" \
      -t "catallaxy-agent:latest" \
      --load \
      .
  fi
else
  docker build \
    --build-arg "PI_VERSION=$PI_VERSION" \
    -f docker/agent/Dockerfile \
    -t "catallaxy-agent:${TAG}" \
    -t "catallaxy-agent:latest" \
    .
fi

echo "built catallaxy-agent:${TAG}"
