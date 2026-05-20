#!/usr/bin/env bash
set -euo pipefail

real=/usr/bin/docker-real
container="${CATALLAXY_CONTAINER_SANDBOX:-/sandbox}"
host="${CATALLAXY_HOST_SANDBOX:-}"

if [[ -n "$host" ]]; then
  cwd="$(pwd -P 2>/dev/null || pwd)"
  if [[ "$cwd" == "$container" || "$cwd" == "$container"/* ]]; then
    cd "$host${cwd#"$container"}" 2>/dev/null || true
  fi

  args=()
  for arg in "$@"; do
    if [[ "$arg" == "$container" || "$arg" == "$container"/* || "$arg" == "$container":* ]]; then
      args+=("$host${arg#"$container"}")
      continue
    fi
    if [[ "$arg" == --volume="$container"* ]]; then
      args+=("--volume=$host${arg#--volume="$container"}")
      continue
    fi
    if [[ "$arg" == *source="$container"* || "$arg" == *src="$container"* ]]; then
      arg="${arg//source=$container/source=$host}"
      arg="${arg//src=$container/src=$host}"
    fi
    args+=("$arg")
  done
  exec "$real" "${args[@]}"
fi

exec "$real" "$@"
