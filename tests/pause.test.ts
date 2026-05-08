import { expect, test } from "bun:test";
import { ORCHESTRATOR_PATTERNS, parsePidList } from "../orchestrator/pause";

test("parsePidList keeps unique positive pids and excludes self", () => {
  expect(parsePidList("42\nnot-a-pid\n7\n42\n0\n-1\n99\n", 42)).toEqual([7, 99]);
});

test("pause knows every long-running orchestrator loop", () => {
  expect([...ORCHESTRATOR_PATTERNS]).toEqual([
    "bun orchestrator/watch.ts",
    "bun orchestrator/watch-live.ts",
    "bun orchestrator/campaign.ts",
    "bun orchestrator/reopen.ts",
  ]);
});
