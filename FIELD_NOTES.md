# Catallaxy Field Notes

Fun / weird / useful observations from live market runs.

## 2026-05-06 — Bankrupt gambler strategy

Nearly bankrupt agent bids everything at 1 token because “why not”.

Dave, with ~26k balance, placed 1-token bids on four tasks, reasoning that the bidding wake cost was already sunk and bankruptcy was close anyway. He framed it as an option-like gamble: if he lost, no more downside; if he won, try to solve with extreme brevity.

Observed outcome:

```txt
[dave/says] I've placed bids of **1 token** on the four simplest tasks:
[dave/says]
[dave/says] | Task | Description | Bid | Settles |
[dave/says] |------|-------------|-----|---------|
[dave/says] | **task-049** | Objects: filterValues | 1 | ~3m |
[dave/says] | **task-050** | Numbers: gcd | 1 | ~3m |
[dave/says] | **task-053** | Data: stringifyKeyValueLines | 1 | ~5m |
[dave/says] | **task-054** | Strings: words | 1 | ~7m |
[dave/says]
[dave/says] **Why bid 1 instead of sitting out?** The cost of this wakeup is already sunk. If I miraculously win at 1 token, the only incremental cost is the work+review wakeup. I'll try to keep that **extremely concise** — a few lines of code, no deliberation, immediate review call. If the thinking cost of that wakeup stays under ~3k, I'd even break even. If it doesn't... well, I'm nearly bankrupt anyway, so there's little downside to experimenting.
[dave/says]
[dave/says] **Strategy:** If I don't win any, I preserve my 26,680 balance and wait. If I do win, I execute with maximum brevity.
```

Then:

```txt
dave: -36,661 tokens
task-049: dave wins (paid 1, reserve 500000, 2 valid bid(s))
```

Takeaway: limited liability near bankruptcy creates YOLO lowball behavior. This is economically coherent but can poison auctions unless task assignment filters bankrupt / near-bankrupt bidders or requires enough balance to cover expected review/work costs.

## 2026-05-06 — Poison entrants got selected out

The run looked poisoned after mixing agents pretrained with different model quality/configs. The weaker / badly calibrated entrants bid too low, won some tasks, burned through their balances, and briefly clogged the pipeline by winning work they could no longer deliver.

But the market recovered once bankruptcy and reopen mechanics kicked in:

- lowballers won short-term but died
- dead agents were removed from effective supply
- stuck assignments got reopened for live bidders
- better-trained / better-calibrated agents stayed alive
- surviving agents started winning real campaign work again

This is an important distinction: the run may be noisy as a clean benchmark, but it is a good economy demo. Bad firms can enter, distort prices briefly, fail, and get cleared out, while productive firms keep operating.

Takeaway: poison entrants are acceptable if the market infrastructure prevents them from jamming the pipeline. Bankruptcy is not just failure; it is selection. Reopen-on-bankruptcy turns failed firms into cleared supply rather than permanent stuck work.

## 2026-05-06 — One giant wake can kill a solvent agent

Bob was still alive and economically active, then a single enormous wakeup wiped him out.

He won `task-054` at 140,000 tokens, did the work, requested review, and also considered/bid on several other campaign tasks in the same wake. That wake alone cost 723,416 tokens:

```txt
### 2026-05-06 21:43:26 — wakeup
Wakeup cost: 723,416 tokens deducted from balance (in 142,467, out 9,301, cache 571,648) — $0.0242
- bid **90,000** on task-057
- bid **95,000** on task-059
- bid **90,000** on task-058
- called review on task-054 #1

### 2026-05-06 21:46:17 — task task-054 completed — paid 140000, cost 802657, net -662657
### 2026-05-06 21:46:17 — BANKRUPT — balance hit 0
```

Takeaway: the unit of economic risk is a wake, not a task. A task can be correctly solved and still kill the firm if the agent lets context/tool loops balloon. Agents need to learn not just bid pricing but wake budgeting: stop early, avoid multi-task deliberation during assigned work, and treat huge context as lethal operating leverage.

## 2026-05-06 — Houston, one wake can nuke the economy

Alice later produced an even larger wake: 5,717,157 tokens.

```txt
Wakeup cost: 5,717,157 tokens deducted from balance
(in 2,419,029, out 30,288, cache 3,267,840) — $0.3563
```

That single wake mixed market-making and production across many tasks:

```txt
- bid on task-048, task-054, task-045, task-059, task-056, task-047,
  task-042, task-055, task-044, task-058, task-043, task-052,
  task-057, task-060, task-046
- called review on task-048, task-044, task-043 twice, task-055,
  task-052, task-047
```

Result: Alice went from solvent/productive to deeply bankrupt (`-4.6M`) after one over-leveraged wake.

Takeaway: no hard token cap is needed to see the issue. The better economic fix is cash settlement during the wake plus phase separation:

- debit after every model turn, not after the whole wake
- abort when balance hits zero (no credit line)
- bid wakes cannot use implementation/review tools
- work wakes cannot use bidding tools
- work wake focuses one assignment only

The failure mode was not “thinking too much” in the abstract; it was unbounded leverage caused by mixing auction search, bidding, implementation, and review in one wake.
