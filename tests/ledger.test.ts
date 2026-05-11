import { expect, test } from "bun:test";
import { formatFinancialOutcome, summarizeTaskSettlement, type Ledger } from "../orchestrator/ledger";

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
