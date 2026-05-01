# Catallaxy agent sandbox

This document describes how agents are isolated in production. The
threat model: an agent's `pi` may be compromised by prompt injection,
model malice, or hallucination. After the rollout below, an agent
must be unable to (a) read/write any file outside its own sandbox,
(b) reach any network endpoint other than OpenRouter, (c) read or
guess the OpenRouter key, (d) interfere with peer agents or the
orchestrator.

## Layout

```
host
├── orchestrator (bun)
│   ├── RPC server (TCP, one port per agent, base 9443)
│   ├── Egress proxy (HTTP, one port per agent, base 8443)
│   ├── Reviewer (claude -p, stays on host)
│   └── Container manager (docker run per wake)
└── agent containers (docker)
    └── pi → catallaxy tools via host.docker.internal:{rpc_port}
         → OpenRouter via host.docker.internal:{proxy_port}
```

## What's mounted into an agent container

Read-write:

- `/sandbox` — the agent's writable area. Equals `agents/{name}/sandbox`
  on the host. Anything else under `agents/` or under the catallaxy
  repo is invisible.

Read-only:

- `/pi-config/models.json` — pi's `models.json` redirecting the
  openrouter provider to `http://host.docker.internal:{proxy_port}/api/v1`.
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
- `--memory=2g --cpus=1 --pids-limit=128`
- `--network catallaxy-agents` — a dedicated bridge that egresses
  through the host but only the proxy port is reachable for the
  external API surface

## Egress proxy

`orchestrator/proxy/server.ts` runs one HTTP listener per agent on
`8443 + index`. Pi inside the container is configured (via the
mounted `models.json`) to use this listener as its OpenAI-compatible
baseUrl. The proxy:

1. Allowlists OpenRouter API paths (`/api/v1/{chat/completions,
   messages, models, completions, embeddings}`).
2. Strips the incoming `Authorization` header (the agent's dummy key).
3. Injects the orchestrator's real OpenRouter key from
   `OPENROUTER_API_KEY` or `orchestrator/private/openrouter.key`.
4. Forwards to `https://openrouter.ai/api/v1/...`.
5. Streams the response back unchanged.
6. Audits each call to `orchestrator/private/audit/proxy-{agent}.jsonl`.

CONNECT (HTTPS tunneling) is rejected. End-to-end TLS would defeat
key injection.

## RPC server

`orchestrator/rpc/server.ts` listens on `0.0.0.0:9443+i` (one port
per agent). The container resolves `host.docker.internal` to the
host and connects via `CATALLAXY_RPC_ADDR=host.docker.internal:{port}`
which the orchestrator passes in via -e. Identity is implicit:
whichever port a connection arrived on determines the calling agent
— agent names in request payloads are ignored.

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
env | grep -iE 'key|token'       # empty
curl http://host.docker.internal:8443/api/v1/models  # works (proxied)
curl https://api.openrouter.ai/api/v1/models         # 403 (no DNS, but path forbidden via proxy)
```

The agent's audit log (`orchestrator/private/audit/bob.jsonl`) shows
every RPC call with timestamps. The proxy audit log
(`orchestrator/private/audit/proxy-bob.jsonl`) shows every upstream
call.
