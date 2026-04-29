/**
 * Exchange — reverse Vickrey auction with private reservation price.
 *
 * Stateless. Reads open tasks past their deadline, picks winner, writes assignment.
 * Last-write-wins per (task, agent) bid file (so agents can revise bids).
 */

import { readdir } from "node:fs/promises";
import { TaskSchema, BidSchema, type Task } from "./schemas";

const MARKET = process.env.MARKET_DIR ?? "./market";
const RESERVATIONS_PATH = process.env.RESERVATIONS_PATH ?? "./orchestrator/private/reservations.json";

async function loadReservations(): Promise<Record<string, number>> {
  try {
    return await Bun.file(RESERVATIONS_PATH).json();
  } catch {
    return {};
  }
}

async function readJson<T>(path: string, schema: { parse: (d: unknown) => T }): Promise<T> {
  const raw = await Bun.file(path).json();
  return schema.parse(raw);
}

async function readAllInDir<T>(dir: string, schema: { parse: (d: unknown) => T }): Promise<T[]> {
  const entries: T[] = [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return entries;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      entries.push(await readJson(`${dir}/${f}`, schema));
    } catch (e) {
      console.error(`Skipping invalid file ${dir}/${f}:`, e);
    }
  }
  return entries;
}

/**
 * Resolve any open tasks whose deadline has passed (deadline_at <= now).
 * Returns count of newly-resolved tasks (assigned + expired).
 */
export async function resolveAuctions(now: Date = new Date()): Promise<{ assigned: number; expired: number }> {
  const tasks = await readAllInDir(`${MARKET}/tasks`, TaskSchema);
  const bids = await readAllInDir(`${MARKET}/bids`, BidSchema);
  const reservations = await loadReservations();

  let assigned = 0;
  let expired = 0;

  for (const task of tasks) {
    if (task.status !== "open") continue;
    if (new Date(task.deadline_at) > now) continue; // not past deadline yet

    const reservation = reservations[task.id];
    if (reservation === undefined) {
      console.warn(`  ${task.id}: no reservation price set, skipping`);
      continue;
    }

    const taskBids = bids.filter((b) => b.task_id === task.id);
    const validBids = taskBids
      .filter((b) => b.price <= reservation)
      .sort((a, b) => a.price - b.price);

    if (validBids.length === 0) {
      const updatedTask: Task = { ...task, status: "expired" };
      await Bun.write(
        `${MARKET}/tasks/${task.id}.json`,
        JSON.stringify(updatedTask, null, 2)
      );
      console.log(
        `  ${task.id}: EXPIRED — ${taskBids.length} bid(s), none ≤ reservation ${reservation}`
      );
      expired++;
      continue;
    }

    const winner = validBids[0];
    // First-price (lowest bid wins, paid their bid). Simpler than Vickrey,
    // gives agents real pricing pressure: you eat what you bid.
    const payment = winner.price;

    const assignment = {
      task_id: task.id,
      winner: winner.agent,
      payment,
      assigned_at: now.toISOString(),
    };

    await Bun.write(
      `${MARKET}/assignments/${task.id}.json`,
      JSON.stringify(assignment, null, 2)
    );

    const updatedTask: Task = { ...task, status: "assigned" };
    await Bun.write(
      `${MARKET}/tasks/${task.id}.json`,
      JSON.stringify(updatedTask, null, 2)
    );

    console.log(
      `  ${task.id}: ${winner.agent} wins (paid ${payment}, reserve ${reservation}, ${validBids.length} valid bid(s))`
    );
    assigned++;
  }

  return { assigned, expired };
}

// Run standalone (settles whatever is past deadline now)
if (import.meta.main) {
  const result = await resolveAuctions();
  console.log(`Exchange: ${result.assigned} assigned, ${result.expired} expired`);
}
