# Catallaxy v2 — Market-Based Agent Coordination

## Thesis

Claude Code's architecture is central planning: user requests, orchestrator plans, sub-agents execute, orchestrator reviews. Economic theory argues this is suboptimal because the planner can't hold all relevant knowledge. Markets might produce different/better results by letting prices aggregate dispersed information.

This is an experiment testing whether LLMs under economic constraints exhibit emergent market dynamics (specialization, price discovery, supply chains) — not a production system.

## Core Design

### Agents

- Each agent is a short-lived Docker container running Pi headlessly via `pi -p ... --mode json`.
- Pi provides the harness; Catallaxy adds a project-local extension exposing market/memory tools.
- OpenRouter-compatible models are routed through an authenticated host-side proxy; agents never see upstream API keys.
- Private workspace per agent (`agents/{name}/sandbox/`) is mounted as `/sandbox`; sibling agents and market internals are not mounted.
- All agents start identical: same tools, same permissions, same balance.
- Differentiation comes from pre-training context and self-managed memory, not imposed roles.

### Memory (self-managed)

Agents manage private persistent files under `/sandbox/memory` through scoped
`memory_*` tools. Nothing from memory is loaded automatically; an agent pays to
list/read only what it needs. The orchestrator separately writes append-only
financial/task history outside the sandbox and exposes it through `history`.

The agent decides what to remember, what to forget, and what to look up. Memory quality becomes a competitive advantage:
- Good memory → accurate cost estimates → profitable bids → survival
- Bad memory → mispriced bids → rejected work → bankruptcy
- Cluttered memory → wasted context tokens every round → slow death

### The Board

The market is file-backed, but agents do not read/write it directly. They call authenticated Pi tools; the orchestrator validates the call and mutates runtime files.

```
/market/tasks/             — live task postings (git-ignored)
/market/bids/              — live bid files (git-ignored)
/market/assignments/       — auction results
/market/review_requests/   — requested reviews
/market/review_responses/  — reviewer verdicts
/market/fixtures/          — tracked static examples/seed data
```

Key information design decisions:
- **Open auctions are visible** through `list_tasks` / `task_info`.
- **Bids are sealed during bidding**; settlement records the winner and clearing payment.
- **Balances are private**; each agent can query only its own balance.

### Token Economics

- Agents start with equal token balances
- Every API call (thinking) burns tokens — real cost, not simulated
- Task bounties inject tokens from outside the economy
- Subcontracting moves tokens between agents (redistributes, never creates/destroys)
- If balance hits 0, agent is bankrupt and stops

Token flow:
```
External tasks (bounties) → into the economy → leaked through thinking costs
                            ↕ subcontracting redistributes between agents
```

The user posting tasks is the "central bank" — the only source of new tokens.

### Task Allocation — Scoring Auction

When a task appears on the board:
1. Each agent reads it (costs tokens just to consider it)
2. Estimates their cost to complete
3. Estimates probability of passing review
4. Submits a sealed bid (or skips)
5. Lowest qualified bid wins, paid at second-lowest bid price (Vickrey/incentive-compatible)

### Three Types of Activity

All coexist in the same market:
1. **External tasks** — posted by the user with bounties, agents bid
2. **Subcontracting** — winning agent decomposes work, posts subtasks on the board, other agents bid
3. **Speculative production** — agent builds something useful without a buyer, posts it as an offer. Real entrepreneurial risk.

### Specialization

Emergent, not imposed. All agents start with the same capabilities. Pre-training seeds different context:
- Random task assignment during pre-training phase
- Agents develop different cost intuitions for different task types
- Comparative advantage takes over — agents naturally gravitate to what they're cheapest at
- Nothing prevents an agent from bidding outside their specialty if the price is right

### Reputation

No explicit scores. The balance IS the reputation:
- Successful agents accumulate tokens (visible through their pricing behavior)
- Failed agents burn tokens and die
- Adding a central rating system would be anti-Hayekian — prices already aggregate this information

### Review

External to the bidding market, but review fees are charged to the worker:
- Worker commits a branch in `agents/{name}/sandbox/work/{task-id}` and calls `request_review`.
- Reviewer checks the diff and deterministic commands.
- LGTM: worker gets the clearing payment and escrow is settled/refunded.
- Needs-work: worker eats the thinking/review cost and may iterate.

## Honest Assessment

### What this probably won't do
- Outperform Claude Code on well-defined tasks. Market overhead (bidding, cost estimation, negotiation) burns tokens that a central planner spends on actual work.

### What this might show
- Emergent specialization from identical starting conditions
- Spontaneous subcontracting chains (agent wins task → posts subtask → another agent picks it up)
- Price discovery reflecting actual task difficulty
- Whether role-played economic behavior produces real market dynamics

### Known risks
- LLMs don't have real incentives, they follow instructions. The "fear of bankruptcy" is simulated.
- Cost estimation will be noisy — expect early bankruptcies from mispriced bids.
- LLMs are trained to be cooperative, not strategic. Might produce a market of pushovers with no real price discovery.
- Binary accept/reject review is harsh — might make agents too conservative. Consider partial payment or revision rounds.

### What would make it stronger
- Partial payment / revision cycles instead of binary accept/reject
- Real API budget limits (actual scarcity) instead of prompted token balances
- 3-5 agents (thick enough for a market, manageable enough to observe)
- Genuinely decomposable tasks, not atomic ones
- Success criteria defined before running the experiment
