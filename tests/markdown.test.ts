import { expect, test } from "bun:test";
import { renderMarkdownTables } from "../orchestrator/markdown";

test("renders markdown pipe tables as terminal tables", () => {
  const input = [
    "Bids:",
    "| Task | Function | Bid |",
    "|------|----------|-----|",
    "| task-001 | slugify | 18,000 |",
    "| task-002 | sum | 15,000 |",
  ].join("\n");

  expect(renderMarkdownTables(input)).toBe([
    "Bids:",
    "┌──────────┬──────────┬────────┐",
    "│ Task     │ Function │ Bid    │",
    "├──────────┼──────────┼────────┤",
    "│ task-001 │ slugify  │ 18,000 │",
    "│ task-002 │ sum      │ 15,000 │",
    "└──────────┴──────────┴────────┘",
  ].join("\n"));
});
