/**
 * Reopen assigned tasks that can no longer be completed.
 *
 * Today the only deterministic unsolvable condition is bankruptcy: if the
 * assignment winner's balance is <= 0, the watcher will never wake them again,
 * so the task would otherwise stay assigned forever. Reopening clears stale
 * bids and assignment state, extends the auction deadline, and lets live agents
 * bid fresh.
 */

import { readdir, rm } from "node:fs/promises";
import { AssignmentSchema, BidSchema, TaskSchema, type Task, type Ledger } from "./schemas";
import { loadLedger, recordEvent } from "./ledger";
import { logEvent } from "./events";

const MARKET = process.env.MARKET_DIR ?? "./market";
const REOPEN_DEADLINE_MS = Number(process.env.REOPEN_DEADLINE_MS ?? String(5 * 60_000));
const REOPEN_TICK_MS = Number(process.env.REOPEN_TICK_MS ?? String(15_000));

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function readJsonOrNull<T>(path: string, schema: { parse: (d: unknown) => T }): Promise<T | null> {
  try {
    return schema.parse(await Bun.file(path).json());
  } catch {
    return null;
  }
}

export interface ReopenResult {
  reopened: string[];
}

export async function reopenUnsolvableAssignments(
  ledger: Ledger,
  now: Date = new Date()
): Promise<ReopenResult> {
  const reopened: string[] = [];

  for (const f of await listJson(`${MARKET}/assignments`)) {
    const assignment = await readJsonOrNull(`${MARKET}/assignments/${f}`, AssignmentSchema);
    if (!assignment) continue;

    const task = await readJsonOrNull(`${MARKET}/tasks/${assignment.task_id}.json`, TaskSchema);
    if (!task || task.status !== "assigned") continue;

    const winnerBalance = ledger[assignment.winner]?.balance ?? 0;
    if (winnerBalance > 0) continue;

    await reopenTask(task, assignment.winner, now);
    reopened.push(task.id);
  }

  return { reopened };
}

async function reopenTask(task: Task, winner: string, now: Date): Promise<void> {
  const newDeadline = new Date(now.getTime() + REOPEN_DEADLINE_MS);
  const reopenedTask: Task = {
    ...task,
    status: "open",
    deadline_at: newDeadline.toISOString(),
  };

  // Remove assignment first: once task is open again, there must not be a
  // stale winner file racing with the exchange/reviewer.
  await rm(`${MARKET}/assignments/${task.id}.json`, { force: true });

  // Clear all previous bids for this task. They were made under a previous
  // auction window and may include bankrupt bidders or stale pricing. Fresh
  // auction, fresh bids.
  for (const bidFile of await listJson(`${MARKET}/bids`)) {
    const path = `${MARKET}/bids/${bidFile}`;
    const bid = await readJsonOrNull(path, BidSchema);
    if (bid?.task_id === task.id) await rm(path, { force: true });
  }

  await Bun.write(`${MARKET}/tasks/${task.id}.json`, JSON.stringify(reopenedTask, null, 2));

  await recordEvent(
    winner,
    now,
    `task ${task.id} reopened — assignment winner bankrupt before completion; old bids cleared`
  );
  await logEvent({
    type: "assignment_reopened",
    at: now.toISOString(),
    task_id: task.id,
    agent: winner,
    reason: "winner_bankrupt",
    old_deadline_at: task.deadline_at,
    new_deadline_at: newDeadline.toISOString(),
  });
}

async function runOnce(): Promise<void> {
  const ledger = await loadLedger();
  const r = await reopenUnsolvableAssignments(ledger);
  if (r.reopened.length) console.log(`reopened: ${r.reopened.join(", ")}`);
}

if (import.meta.main) {
  if (process.argv.includes("--watch")) {
    console.log(`reopen watcher running (tick ${REOPEN_TICK_MS}ms)`);
    await runOnce();
    setInterval(() => { runOnce().catch((e) => console.error("reopen tick failed", e)); }, REOPEN_TICK_MS);
    await new Promise(() => {});
  } else {
    await runOnce();
  }
}
