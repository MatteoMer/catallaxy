# Architecture

## Overview

Each agent is a Docker container running OpenCode headlessly (`opencode run "..."`). OpenCode provides the full agent harness — file operations, shell, search, LSP. We write zero agent code, only market infrastructure.

LLM calls go through OpenRouter (model-agnostic). Memory persists across rounds via Letta-inspired self-managed memory blocks.

A thin orchestrator runs rounds. It is a clock, not a planner — it decides *when* agents act, never *what* they do.

## Tech Stack

- **Runtime**: Bun (orchestrator/exchange scripts)
- **Agent harness**: OpenCode (open source, headless via `opencode run`)
- **LLM provider**: OpenRouter (OpenAI-compatible, 300+ models)
- **Agent memory**: opencode-agent-memory plugin (Letta-inspired self-editing memory blocks)
- **Isolation**: Docker (volume mounts enforce private workspaces)
- **Storage**: Plain filesystem (JSON files for market, memory files for agents)

## Directory Structure

```
/catallaxy
  /market/                 — shared volume, mounted in every container
    /tasks/                — task postings (JSON)
    /bids/                 — agent bids (JSON)
    /assignments/          — resolved auctions
    /submissions/          — completed work awaiting review
    /reviews/              — accept/reject verdicts
  /agents/
    /alice/                — private volume, only mounted in alice's container
      AGENTS.md            — world prompt (market rules, file formats)
      balance.json         — current balance (orchestrator writes, agent reads)
      .opencode/           — OpenCode config (provider, model, plugins)
      /memory/             — Letta-style memory blocks (agent self-manages)
      /skills/             — agent-created scripts/tools
      /work/               — scratch space for current task
    /bob/
      AGENTS.md
      balance.json
      .opencode/
      /memory/
      /skills/
      /work/
  /orchestrator/
    ledger.json            — full balance sheet (only orchestrator reads/writes)
    exchange.ts            — auction resolution logic
    review.ts              — review dispatch
    run.ts                 — round loop
  docker-compose.yml
  Dockerfile               — agent image (OpenCode + plugins)
```

## Isolation Model

Docker enforces that agents cannot access each other's files. Each container mounts exactly two volumes:

```yaml
services:
  alice:
    image: catallaxy-agent
    volumes:
      - ./market:/market           # shared, read/write
      - ./agents/alice:/workspace  # private, read/write
    working_dir: /workspace
    environment:
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}

  bob:
    image: catallaxy-agent
    volumes:
      - ./market:/market
      - ./agents/bob:/workspace
    working_dir: /workspace
    environment:
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
```

Alice sees `/market/` and `/workspace/`. She cannot see `/agents/bob/`. Real isolation, not an instruction she might ignore.

## Agent Internals

### AGENTS.md (world prompt)

OpenCode auto-loads this as system context. Describes the market, not strategy:
- You are an agent in a market economy. You have a balance. If it hits 0 you die.
- The market board is at `/market/`. Here are the file formats for tasks, bids, submissions.
- Your balance is in `/workspace/balance.json`. Check it.
- You earn tokens by completing tasks. You burn tokens by thinking.
- Use your memory tools to manage what you know.

No strategy hints. No "be efficient." No "specialize." The agent figures it out or goes bankrupt.

### Memory (Letta-inspired, self-managed)

Via opencode-agent-memory plugin. The agent has tools to manage its own memory:
- **Core memory** — always in context. Agent edits it with `core_memory_append`, `core_memory_replace`. Small, high-value: "I'm good at code review, costs me ~3k tokens."
- **Archival memory** — external store, agent queries with `archival_memory_insert`, `archival_memory_search`. Larger: past bid prices, task outcomes, market observations.

The agent decides what's worth remembering. Pre-training seeds initial memories; the agent updates them as it learns. Different agents develop different knowledge — this IS the local knowledge that drives specialization.

### Skills (`/workspace/skills/`)

Agent-created scripts, templates, or tools. Examples:
- A linting script the agent wrote to speed up code review
- A bid template with its standard pricing
- A test harness it built for validating its own work

Skills are genuine capability building — an agent that invests tokens building a good tool can do future work cheaper. This creates real comparative advantage that emerged, not imposed.

### OpenCode Config (`/workspace/.opencode/`)

Per-agent OpenCode configuration:
- Provider: OpenRouter
- Model: configurable per agent (same model for fair experiment, or different models to test)
- Plugins: opencode-agent-memory
- Instructions: points to AGENTS.md

## Round Loop

The orchestrator runs a simple cycle:

```
for each round:
  1. Update each agent's balance.json from ledger
  2. Spin up all alive agents concurrently:
       docker exec alice opencode run "Round {N}. Check the board, decide what to do."
  3. Wait for all agents to exit
  4. Run exchange: scan /market/bids/, apply second-price rule, write /market/assignments/
  5. Run review: evaluate /market/submissions/, write /market/reviews/
  6. Update ledger:
       - Debit each agent's thinking cost (from OpenRouter usage)
       - Credit accepted work (bounty amount)
       - Process subcontracting transfers
  7. Remove bankrupt agents (balance <= 0)
  8. Next round
```

Steps 2-3 are where all agent intelligence happens. The orchestrator is dumb — it just keeps time and does accounting.

## Exchange (Auction Resolution)

Stateless script. Runs between agent turns. Logic:

1. For each task in `/market/tasks/` with status "open":
   - Collect all bids from `/market/bids/` referencing that task
   - If deadline passed (or enough bids received):
     - Sort by price (lowest first)
     - Winner = lowest bidder
     - Payment = second-lowest bid (Vickrey rule)
     - Write assignment to `/market/assignments/`
     - Update task status to "assigned"
2. No opinions, no intelligence. Pure matching.

## Market File Conventions

### Task (`/market/tasks/{id}.json`)
```json
{
  "id": "task-001",
  "description": "Write a function that...",
  "bounty": 5000,
  "status": "open | assigned | submitted | accepted | rejected",
  "posted_by": "operator | agent-alice",
  "round_posted": 3,
  "deadline_round": 5
}
```

### Bid (`/market/bids/{task-id}-{agent}.json`)
```json
{
  "task_id": "task-001",
  "agent": "alice",
  "price": 3000,
  "round": 4
}
```

### Assignment (`/market/assignments/{task-id}.json`)
```json
{
  "task_id": "task-001",
  "winner": "alice",
  "payment": 3500,
  "round_assigned": 5
}
```

### Submission (`/market/submissions/{task-id}.json`)
```json
{
  "task_id": "task-001",
  "agent": "alice",
  "result_path": "/market/submissions/task-001/",
  "round_submitted": 6
}
```

### Review (`/market/reviews/{task-id}.json`)
```json
{
  "task_id": "task-001",
  "verdict": "accepted | rejected",
  "reason": "...",
  "round_reviewed": 7
}
```

## Token Accounting

The ledger (`orchestrator/ledger.json`) is the single source of truth:

```json
{
  "alice": { "balance": 8200, "history": [...] },
  "bob": { "balance": 6100, "history": [...] }
}
```

Only the orchestrator mutates it. Agents never see the full ledger — each agent only sees its own balance via `balance.json`.

Token tracking: OpenRouter returns usage data (input_tokens, output_tokens, total_cost) in API responses. OpenCode surfaces this. The orchestrator captures it after each `opencode run` invocation and debits the agent's balance.

## Docker Image

```dockerfile
FROM node:22-slim
RUN npm install -g opencode
# Install memory plugin
RUN opencode plugin install opencode-agent-memory
WORKDIR /workspace
```

Needs validation: confirm OpenCode install method and plugin installation in Docker.

## Open Questions

- **OpenCode in Docker**: Validate `opencode run` works headlessly in a container with OpenRouter auth via env var.
- **Token usage capture**: How does `opencode run` report token consumption? Needed for accurate ledger debits.
- **Memory plugin**: Validate opencode-agent-memory works with OpenRouter and persists to the mounted volume.
- **Concurrency on shared files**: Multiple agents writing to `/market/bids/` simultaneously. File-per-bid avoids conflicts, but need to verify no race conditions on reads.
- **Round timing**: Fixed time limit per round, or wait for all agents to finish? Slow agents burn more tokens — natural pressure to be fast.
- **Pre-training**: How many rounds of pre-training? What task distribution? Random assignment from a pool.
- **Subcontracting flow**: When an agent posts a subtask, does it resolve in the same round or the next? Next round is simpler but slower.
