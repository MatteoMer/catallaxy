# Architecture

## Overview

Catallaxy is an event-driven market for coding agents. Agents bid for tasks,
work only after assignment, and get paid only after review returns LGTM. The
orchestrator is infrastructure, not a planner: it settles auctions, wakes agents,
tracks balances, and runs reviews.

Agents run `pi` headlessly in short-lived Docker containers. They never read the
market filesystem directly. A project-local Pi extension exposes market tools
(`list_tasks`, `place_bid`, `request_review`, memory tools, etc.) and talks to
the host orchestrator over authenticated TCP RPC. Model traffic and package
manager egress go through an authenticated host-side proxy.

## Tech stack

- **Runtime**: Bun + TypeScript scripts under `orchestrator/`.
- **Agent harness**: Pi (`pi -p ... --mode json`) with `extensions/catallaxy.ts`.
- **LLM provider**: OpenRouter-compatible models through the proxy; reviewer
  defaults to local Codex/Pi on the host unless sandboxed.
- **Isolation**: Docker containers with a read-only rootfs, private `/sandbox`,
  no upstream API keys, and an internal bridge network.
- **Storage**: Plain JSON files for market state and ledgers. Runtime market
  state is ignored by git; static examples live under `market/fixtures/`.
- **User interface**: `.pi/extensions/catallaxy-interface/` turns normal Pi
  sessions launched via `bin/catallaxy` into test-first campaigns.

## Directory layout

```txt
/catallaxy
  /.pi/extensions/catallaxy-interface/  interactive campaign intake extension
  /agents/{name}/sandbox/               private agent sandbox mounted as /sandbox
    balance.json                        own balance snapshot, written by orchestrator
    identity.json                       canonical agent name
    memory/                             self-managed private persistent notes
    work/{task-id}/                     private clone for assigned work
    SYSTEM.md                           symlink to root system prompt
  /extensions/catallaxy.ts              Pi extension loaded in agent containers
  /market/                              runtime market filesystem
    tasks/                              live task postings (git-ignored)
    bids/                               live bid files (git-ignored)
    assignments/                        live auction results (git-ignored)
    review_requests/                    live review requests (git-ignored)
    review_responses/                   live review verdicts (git-ignored)
    pending_summaries/                  deferred cost-summary markers (git-ignored)
    fixtures/                           tracked static examples/seed data
  /orchestrator/
    watch.ts                            event-driven runtime loop
    exchange.ts                         reverse Vickrey settlement
    reviewer.ts                         review request processing
    ledger.ts                           balance/token accounting + histories
    rpc/                                authenticated tool RPC server
    proxy/                              authenticated egress proxy
    private/                            ignored ledgers, audit logs, history, campaigns
  /docs/                                operator notes
  /docker/agent/                        agent image + seccomp profile
```

## Isolation model

Each wake starts a fresh agent container with only two host mounts:

```txt
/sandbox       rw  agents/{name}/sandbox
/pi-config     ro  generated Pi config; routes provider traffic to the proxy
```

The root filesystem is read-only with tmpfs for `/tmp` and `/home/catallaxy`.
The container runs as uid/gid `1000:1000`, drops all capabilities, uses
`no-new-privileges`, memory/CPU/pid limits, and AppArmor/seccomp when available.
It is attached only to the `catallaxy-agents` internal Docker bridge.

A long-lived `catallaxy-gateway` container bridges two ports from that internal
network to host listeners:

```txt
catallaxy-gateway:9443 -> host RPC server
catallaxy-gateway:8443 -> host egress proxy
```

Agents cannot reach sibling sandboxes, the host checkout, the ledger, or the
public internet directly. Package-manager HTTPS traffic is allowed only through
the authenticated proxy CONNECT allowlist.

## Agent interface

The agent prompt is built per wake by `orchestrator/watch.ts` and includes an
explicit tool allowlist.

- **Bid wakes** expose auction/pricing tools only. Implementation, shell, file,
  assignment, and review tools are disabled.
- **Work wakes** are scoped to one assigned task. `task_info`, `request_review`,
  and worktree file/shell tools are limited to that focused assignment.

The Pi extension at `extensions/catallaxy.ts` registers tools. Market and
economic tools forward calls to `orchestrator/rpc/server.ts` using the per-agent
auth token. Identity is fixed by the token; tool payloads cannot choose an agent
name. Memory tools use Pi's local file primitives scoped to `/sandbox/memory`.

RPC-backed tools:

```txt
list_tasks, task_info, place_bid
my_assignments, task_verdicts, request_review
create_task, my_created_tasks, cancel_created_task, merge_task_result
my_balance, history
```

Local sandbox-scoped memory tools:

```txt
memory_list, memory_read, memory_write, memory_edit, memory_delete
```

## Event loop

`orchestrator/watch.ts` runs continuously:

1. Discover agents and ensure sandboxes/configs exist.
2. Start RPC, proxy, and gateway.
3. Watch runtime market directories for new tasks, assignments, and reviews.
4. Schedule auction settlement timers from `deadline_at`.
5. Wake alive agents when they have actionable work or unseen open auctions.
6. Debit thinking cost after every Pi `turn_end` event.
7. Abort the wake immediately if the agent balance crosses zero.
8. Process review requests and advance campaigns.
9. Reopen assignments whose winner is bankrupt.
10. Run a periodic reconciler to catch missed filesystem events.

The orchestrator does not plan implementations. It only gates tools, accounts for
costs, and advances state transitions.

## Auction / exchange

Tasks live in `market/tasks/{task-id}.json`; private reservation prices live in
`orchestrator/private/reservations.json` or escrow records. When a task deadline
passes, `exchange.ts`:

1. Collects one current bid per `(task, agent)` from `market/bids/`.
2. Filters creator/self-bids, bankrupt bidders, and bids above reservation.
3. Selects the lowest valid bidder.
4. Pays the winner the second-lowest valid bid, capped by reservation; with only
   one valid bid, payment is the private reservation.
5. Pre-clones the repo into `agents/{winner}/sandbox/work/{task-id}`.
6. Writes `market/assignments/{task-id}.json` and marks the task assigned.

If no valid bid exists, the task expires and escrow is refunded when applicable.

## Review and completion

A winner edits the private worktree, commits a branch, and calls
`request_review`. The reviewer receives a prompt containing the task description,
subjective criteria, and deterministic checks. On LGTM:

- the worker is credited the assignment payment;
- escrow is settled/refunded;
- the task is marked completed;
- the worker history gets a per-task cost/net summary after the wake debit posts.

On needs-work, feedback is written to `market/review_responses/` and the worker
is woken again for the focused assignment.

## Token accounting

`orchestrator/ledger.json` is the balance source of truth. Agents see only their
own `/sandbox/balance.json` and their append-only history through the `history`
tool. Each Pi turn reports provider usage; `ledger.ts` converts it to billable
tokens using configurable model ratios:

```txt
billable = input + output + cache_write + cache_read * CATALLAXY_CACHE_READ_RATIO
```

The debit happens during the wake, not at the end, so bankruptcy aborts the
container instead of extending credit.

## Campaign interface

`bin/catallaxy` launches Pi with the interface extension enabled. The interface
agent plans a campaign, asks the user to approve, stages tests/support files
under `.catallaxy/campaigns/<id>/staging/`, and posts the first checkpoint task.
After each checkpoint reaches LGTM, `advanceCampaigns()` merges the winning
branch into the campaign worktree and posts the next checkpoint. The final result
is published back to the user's original checkout with a safe `git merge
--ff-only` when possible.

## Runtime state vs fixtures

`market/tasks/` and sibling market directories are live state. They are
intentionally git-ignored because watcher/pretrain/campaign runs mutate them.
Tracked task examples belong in `market/fixtures/`; copy or transform fixtures
into runtime state for demos instead of editing fixture files in place.
