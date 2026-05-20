# Catallaxy agent sandbox

This document describes the two agent container profiles.

Default profile: `CATALLAXY_SANDBOX_PROFILE=devserver`. Agents get a normal dev
server environment: writable container overlay, broad outbound network, larger
memory/shared-memory limits, Docker CLI + Compose, and the host Docker socket
when available. Persistent writes still live in the agent's own sandbox, and
model traffic still goes through the Catallaxy proxy so upstream API keys are not
present in the container.

Locked profile: `CATALLAXY_SANDBOX_PROFILE=secure`. This is the original
production isolation profile. Threat model: an agent's `pi` may be compromised
by prompt injection, model malice, or hallucination. In this mode an agent must
be unable to (a) read/write any file outside its own sandbox, (b) reach any
network endpoint other than model APIs and explicitly allowlisted package
registry/CDN hosts, (c) read or guess upstream API keys, (d) interfere with peer
agents or the orchestrator.

## Layout

```
host
├── orchestrator (bun)
│   ├── RPC server (TCP :9443)
│   ├── Egress proxy (HTTP :8443)
│   ├── Reviewer (claude -p, stays on host)
│   └── Container manager (docker run per wake)
└── agent containers (docker)
    └── pi → catallaxy tools via catallaxy-gateway:9443
         → OpenRouter/Anthropic via catallaxy-gateway:8443
         → npm package egress via authenticated CONNECT proxy on the same port
```

## What's mounted into an agent container

Read-write:

- `/sandbox` — the agent's writable area. Equals `agents/{name}/sandbox`
  on the host. Anything else under `agents/` or under the catallaxy
  repo is invisible.
- Dev-server profile only: `/var/run/docker.sock` (if present) and a second
  mount of the sandbox at its host absolute path. The bundled `docker` wrapper
  rewrites `/sandbox/...` paths to that mirror so `docker compose` bind mounts
  work with the host daemon.

Read-only:

- `/pi-config/models.json` — pi's `models.json` redirecting the
  openrouter provider to the Catallaxy proxy (`host.docker.internal` in
  dev-server, `catallaxy-gateway` in secure).
- `/pi-config/auth.json` and `/pi-config/settings.json` — pre-created
  empty stubs so pi's startup paths don't try to mkdir/write into a
  read-only mount.
- `/catallaxy/extensions/catallaxy.ts` — the RPC-client extension
  baked into the image at build time.

## What's NOT mounted

- The catallaxy repo. The agent has no direct bind mount to `orchestrator/`,
  `market/`, sibling agents' sandboxes, or the host's git history. In
  dev-server mode, mounting the host Docker socket intentionally trades away
  this as a hard security boundary: a determined process with Docker access can
  ask the host daemon to mount other host paths. Use secure mode when that
  boundary matters.
- `~/.pi` from the host. PI_CODING_AGENT_DIR is hard-set to
  `/pi-config` (the read-only mount above).
- Any host shell, env file, or secret material.

## Container profiles (per wake)

Common:

- `--user 1000:1000` (catallaxy user, no host uid match)
- `--cap-drop=ALL`
- `--security-opt no-new-privileges`
- `--init`
- `--shm-size=$CATALLAXY_AGENT_SHM` (default devserver `2g`, secure `512m`)
- model config at `/pi-config` is read-only; upstream API keys stay host-side.

Dev-server defaults:

- writable container overlay (no `--read-only`)
- `--network bridge`, `CATALLAXY_RPC_ADDR=host.docker.internal:9443`
- `--memory=8g --cpus=4 --pids-limit=4096`
- Docker CLI + Compose available; if `/var/run/docker.sock` exists it is mounted
  and `$DOCKER_HOST` points at it. Published service ports are reachable via
  `$CATALLAXY_DEV_HOST` (`host.docker.internal` on bridge, `127.0.0.1` on host
  networking).

Secure defaults:

- `--read-only` root, `tmpfs` for `/tmp` (default 512 MB) and
  `/home/catallaxy` (default 128 MB)
- `--memory=2g --cpus=1 --pids-limit=512`
- `--network catallaxy-agents` — an internal bridge with no direct
  host or internet route. Agents can only reach `catallaxy-gateway`,
  which forwards RPC and proxy ports to the host.

## Egress proxy

`orchestrator/proxy/server.ts` runs one HTTP listener on
`CATALLAXY_PROXY_PORT` (default `8443`). Pi inside the container is
configured (via the mounted `models.json`) to use this listener as its
OpenAI-compatible baseUrl. The proxy:

1. Authenticates every request with the per-agent catallaxy token.
2. Allowlists model API paths under `/openrouter/...` and `/anthropic/...`.
3. Strips caller-supplied upstream auth headers.
4. Injects host-side upstream keys from env or `orchestrator/private/*.key`.
5. Streams the response back unchanged.
6. Audits each call to `orchestrator/private/audit/proxy-{agent}.jsonl`.

CONNECT is enabled only for package-manager HTTPS egress. Agent
containers get `HTTPS_PROXY=http://catallaxy:<token>@catallaxy-gateway:8443`
and npm cache dirs under `/sandbox/.cache/...`. The proxy accepts
`Proxy-Authorization`, only permits port `443`, and only tunnels to
`CATALLAXY_CONNECT_ALLOWLIST` / `CATALLAXY_PACKAGE_EGRESS_HOSTS`
(comma-separated exact hosts or `*.example.com` wildcards; default: npm
registry plus common Prisma/Playwright binary CDNs).
CONNECT has a separate rate limit (`CATALLAXY_CONNECT_RATE_LIMIT`,
default 1200/min) so large installs do not trip the model API limit.
Model traffic never uses CONNECT, so upstream key injection remains
intact.

## RPC server

`orchestrator/rpc/server.ts` listens on `0.0.0.0:9443`. The gateway
forwards `catallaxy-gateway:9443` to the host listener and the agent
connects via `CATALLAXY_RPC_ADDR=catallaxy-gateway:9443`, passed in
via `-e`. Identity comes from the first-frame catallaxy auth token;
agent names in request payloads are ignored.

(Unix sockets would have been simpler, but Docker Desktop on macOS
does not bridge them across the host↔Linux-VM boundary; `connect()`
on a bind-mounted socket node always returns ECONNREFUSED. TCP via
host.docker.internal works on both macOS and Linux.)

RPC-backed methods: `list_tasks`, `task_info`, `my_assignments`,
`task_verdicts`, `place_bid`, `request_review`, `create_task`,
`my_created_tasks`, `cancel_created_task`, `merge_task_result`,
`my_balance`, `history`. The agent also has local `memory_*` tools scoped to
`/sandbox/memory`.

Wire format: line-delimited JSON. See `orchestrator/rpc/protocol.ts`.

Audit log: `orchestrator/private/audit/{agent}.jsonl`. Rate limit:
`CATALLAXY_RPC_RATE_LIMIT` calls per minute (default 120).

## Adding a new tool

1. Add the method handler in `orchestrator/rpc/methods.ts`. Take
   `(agent, params)` and return JSON. Agent identity comes from the
   socket — never trust agent names in params.
2. Register the handler in `HANDLERS`.
3. Add the type to `RpcMethod` in `orchestrator/rpc/protocol.ts`.
4. Add the pi tool in `extensions/catallaxy.ts`. It just calls
   `rpc().call("name", params)`.
5. Rebuild the image (`make image`) so the new extension is baked in.

## Operating cheat sheet

- `make image` — build/rebuild the agent image (multi-arch if `docker buildx` is available)
- `make watch` — start orchestrator (auto-builds image if missing); defaults to `CATALLAXY_SANDBOX_PROFILE=devserver`
- `make pretrain --n 1 --max-iters 3` — bootstrap run
- `make reset` — wipe market state, ledger, sockets, .pi-configs,
  containers, and bridge network
- `make clean` — reset + remove the image
- `CATALLAXY_SANDBOX_PROFILE=secure make watch` — use the locked-down internal-network profile.
- `CATALLAXY_AGENT_MEMORY=12g CATALLAXY_AGENT_SHM=4g make watch` — raise limits for large builds/Playwright/Postgres-heavy tests.
- `BUN_SPAWN_AGENT_DIRECT=1 bun orchestrator/watch.ts` — run agents
  directly on the host (no container). Diagnostics-only; bypasses
  every isolation guarantee.

## Verification (smoke test)

After `make watch` is up and an agent wake is running, exec into an agent
container in another shell:

```sh
docker exec -it catallaxy-agent-bob-w1 sh
cat /sandbox/SYSTEM.md                  # works
cat /orchestrator/ledger.json           # ENOENT
env | grep -iE 'OPENROUTER|ANTHROPIC'   # empty
docker --version && docker compose version
npm view zod version                    # devserver: direct egress; secure: authenticated CONNECT proxy
curl https://example.com                # devserver: works; secure: blocked unless allowlisted
curl -H "Authorization: Bearer $CATALLAXY_AUTH_TOKEN" \
  "http://${CATALLAXY_DEV_HOST:-catallaxy-gateway}:8443/openrouter/api/v1/models" # works
```

The agent's audit log (`orchestrator/private/audit/bob.jsonl`) shows
every RPC call with timestamps. The proxy audit log
(`orchestrator/private/audit/proxy-bob.jsonl`) shows every upstream
call.
