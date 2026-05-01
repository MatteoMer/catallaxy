# Catallaxy v2 — Market-Based Agent Coordination

## Thesis

Claude Code's architecture is central planning: user requests, orchestrator plans, sub-agents execute, orchestrator reviews. Economic theory argues this is suboptimal because the planner can't hold all relevant knowledge. Markets might produce different/better results by letting prices aggregate dispersed information.

This is an experiment testing whether LLMs under economic constraints exhibit emergent market dynamics (specialization, price discovery, supply chains) — not a production system.

## Core Design

### Agents

- Each agent is an OpenCode instance running headlessly via `opencode run "..."`
- OpenCode provides the full agent harness: file read/write, shell, search, LSP — we write zero agent code
- OpenRouter as LLM provider — model-agnostic, swap models per agent if needed
- Private workspace per agent (`/agents/{name}/`) — only they can write to it
- All agents start identical: same tools, same permissions, same balance
- Differentiation comes from pre-training context, not imposed roles

### Memory (Letta-inspired, self-managed)

Agents manage their own memory via dedicated tools. Three tiers:
- **Core memory** — always in context (AGENTS.md). Small, high-value facts the agent updates itself.
- **Archival memory** — larger store the agent queries explicitly. Cost estimates, market observations, task history.
- **Skills** — agent-created scripts, templates, tools that persist across rounds.

The agent decides what to remember, what to forget, what to look up. Memory quality becomes a competitive advantage:
- Good memory → accurate cost estimates → profitable bids → survival
- Bad memory → mispriced bids → rejected work → bankruptcy
- Cluttered memory → wasted context tokens every round → slow death

Implemented via opencode-agent-memory plugin (Letta-inspired memory blocks for OpenCode).

### The Board

File-based shared marketplace. No central coordinator — agents read and write to it themselves.

```
/market/tasks/       — posted tasks, anyone can read
/market/bids/        — agents post bids here (visible to all)
/market/results/     — completed work awaiting review
/agents/alice/       — private workspace
/agents/bob/         — private workspace
```

Key information design decisions:
- **Prices are visible** — this is what makes markets work. Prices aggregate dispersed knowledge.
- **Bids are anonymous** — prevents collusion, forces competition on price/quality
- **Balances are private** — prevents predatory behavior (lowballing a near-bankrupt agent)

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

External to the economy. The reviewer (human or LLM panel) is the "customer":
- Accepts or rejects completed work
- Accepted: agent gets paid the bounty
- Rejected: agent eats the cost of work done
- No token cost for review itself — it's outside the economy

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
