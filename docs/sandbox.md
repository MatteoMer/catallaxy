# Catallaxy agent sandbox

This document describes how agents are isolated in production. The
threat model: an agent's `pi` may be compromised by prompt injection,
model malice, or hallucination. After the rollout below, an agent
must be unable to (a) read/write any file outside its own sandbox,
(b) reach any network endpoint other than model APIs and explicitly
allowlisted package registry/CDN hosts, (c) read or guess upstream API
keys, (d) interfere with peer agents or the orchestrator.

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

Read-only:

- `/pi-config/models.json` — pi's `models.json` redirecting the
  openrouter provider to `http://catallaxy-gateway:{proxy_port}/openrouter/api/v1`.
- `/pi-config/auth.json` and `/pi-config/settings.json` — pre-created
  empty stubs so pi's startup paths don't try to mkdir/write into a
  read-only mount.
- `/catallaxy/extensions/catallaxy.ts` — the RPC-client extension
  baked into the image at build time.

## What's NOT mounted

- The catallaxy repo. The agent has no path to `orchestrator/`,
  `market/`, sibling agents' sandboxes, or the host's git history.
- `~/.pi` from the host. PI_CODING_AGENT_DIR is hard-set to
  `/pi-config` (the read-only mount above).
- Any host shell, env file, or secret material.

## Container hardening (per wake)

- `--user 1000:1000` (catallaxy user, no host uid match)
- `--cap-drop=ALL`
- `--security-opt no-new-privileges`
- `--security-opt seccomp=docker/agent/seccomp.json` (Linux only;
  macOS Docker Desktop ignores custom seccomp)
- `--security-opt apparmor=docker-default` (Linux)
- `--read-only` root, `tmpfs` for `/tmp` (100 MB) and
  `/home/catallaxy` (20 MB)
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

Methods: `list_tasks`, `task_info`, `my_assignments`,
`task_verdicts`, `place_bid`, `request_review`, `my_balance`,
`history`. They map 1:1 to the catallaxy tools an agent's pi sees.

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

- `make image` — build (multi-arch if `docker buildx` is available)
- `make watch` — start orchestrator (auto-builds image if missing)
- `make pretrain --n 1 --max-iters 3` — bootstrap run
- `make reset` — wipe market state, ledger, sockets, .pi-configs,
  containers, and bridge network
- `make clean` — reset + remove the image
- `BUN_SPAWN_AGENT_DIRECT=1 bun orchestrator/watch.ts` — run agents
  directly on the host (no container). Diagnostics-only; bypasses
  every isolation guarantee.

## Verification (smoke test)

After `make watch` is up and `make pretrain` is running, exec into
an agent container in another shell:

```sh
docker exec -it catallaxy-agent-bob-pt1 sh
cat /sandbox/SYSTEM.md           # works
cat /orchestrator/ledger.json    # ENOENT
ls /agents                       # ENOENT
env | grep -iE 'OPENROUTER|ANTHROPIC'  # empty
npm view zod version                    # works through authenticated CONNECT proxy
curl https://example.com                 # 403 via proxy allowlist, or no route if proxy env is unset
curl -H "Authorization: Bearer $CATALLAXY_AUTH_TOKEN" \
  http://catallaxy-gateway:8443/openrouter/api/v1/models      # works
```

The agent's audit log (`orchestrator/private/audit/bob.jsonl`) shows
every RPC call with timestamps. The proxy audit log
(`orchestrator/private/audit/proxy-bob.jsonl`) shows every upstream
call.
