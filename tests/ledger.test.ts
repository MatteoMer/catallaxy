import { expect, test } from "bun:test";
import { billableTokensForUsage, formatFinancialOutcome, summarizeTaskSettlement, tokenAccountingRatiosForModel, usageFromPiUsage, type Ledger } from "../orchestrator/ledger";

test("task settlement summary uses exact task-addressed paid/review entries", () => {
  const ledger: Ledger = {
    alice: {
      balance: 0,
      history: [
        { at: "2026-01-01T00:00:01.000Z", type: "debit_thinking", amount: 100, description: "Wakeup turn" },
        { at: "2026-01-01T00:00:02.000Z", type: "debit_review_fee", amount: 2_000, description: "Review fee: task-001 #1" },
        { at: "2026-01-01T00:00:03.000Z", type: "credit_bounty", amount: 10_000, description: "Accepted: task-001" },
        { at: "2026-01-01T00:00:04.000Z", type: "debit_review_fee", amount: 2_000, description: "Review fee: task-002 #1" },
        { at: "2026-01-01T00:00:05.000Z", type: "credit_bounty", amount: 50_000, description: "Accepted: task-002" },
      ],
    },
  };

  expect(summarizeTaskSettlement(
    ledger,
    "alice",
    "task-001",
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-01T00:00:10.000Z"),
  )).toEqual({ thinking: 100, reviewFees: 2_000, received: 10_000, net: 7_900 });
});

test("financial outcome labels losses as bad and wins as positive net", () => {
  expect(formatFinancialOutcome(-5)).toContain("Financial outcome: LOSS -5 — BAD");
  expect(formatFinancialOutcome(7)).toContain("Financial outcome: WIN +7");
  expect(formatFinancialOutcome(0)).toContain("BREAK-EVEN 0 — not good");
});

test("token accounting discounts cache reads and keeps cache writes at input weight", () => {
  expect(billableTokensForUsage({
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 200,
  })).toBe(450);

  const u = usageFromPiUsage({
    input: 10,
    output: 1,
    cacheRead: 99,
    cacheWrite: 5,
    totalTokens: 115,
    cost: { total: 0.123 },
  });
  expect(u.totalTokens).toBe(115);
  expect(u.billableTokens).toBe(26);
  expect(u.cacheWriteTokens).toBe(5);
});

test("token accounting ratios can be overridden by model", () => {
  const old = process.env.CATALLAXY_MODEL_TOKEN_RATIOS;
  process.env.CATALLAXY_MODEL_TOKEN_RATIOS = JSON.stringify({
    "openrouter/test/model": { output: 4, cacheRead: 0.25, cacheWrite: 1 },
  });
  try {
    expect(tokenAccountingRatiosForModel("openrouter/test/model")).toEqual({
      input: 1,
      output: 4,
      cacheRead: 0.25,
      cacheWrite: 1,
    });
    expect(billableTokensForUsage({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    }, "openrouter/test/model")).toBe(165);
  } finally {
    if (old === undefined) delete process.env.CATALLAXY_MODEL_TOKEN_RATIOS;
    else process.env.CATALLAXY_MODEL_TOKEN_RATIOS = old;
  }
});
