import { expect, test } from "bun:test";
import { summarizeTaskSettlement, type Ledger } from "../orchestrator/ledger";

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
