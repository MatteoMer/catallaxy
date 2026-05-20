/**
 * Exchange — reverse Vickrey auction with a reservation price.
 *
 * Stateless. Reads open tasks past their deadline, picks winner, writes assignment.
 * Last-write-wins per (task, agent) bid file (so agents can revise bids).
 */

import { readdir } from "node:fs/promises";
import { TaskSchema, BidSchema, type Task, type Bid, type Ledger } from "./schemas";
import { loadLedger, recordEvent, saveLedger, syncBalances } from "./ledger";
import { refundEscrow } from "./escrow";
import { prepareWorkDir } from "./workdir";
import { dim, red, brightGreen, brightYellow } from "./log";

const MARKET = process.env.MARKET_DIR ?? "./market";
const RESERVATIONS_PATH = process.env.RESERVATIONS_PATH ?? "./orchestrator/private/reservations.json";

let auctionResolveLock: Promise<void> = Promise.resolve();

async function withAuctionResolveLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = auctionResolveLock;
  let release!: () => void;
  auctionResolveLock = new Promise<void>((resolve) => { release = resolve; });

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

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
 * Reverse Vickrey clearing price: lowest bidder wins, but is paid the
 * second-lowest valid bid. If there is only one valid bid, the reservation
 * price is the outside option / cap, so the winner is paid it.
 */
export function clearingPayment(validBids: Pick<Bid, "price">[], reservation: number): number {
  if (validBids.length === 0) throw new Error("clearingPayment requires at least one valid bid");
  const prices = validBids.map((b) => b.price).sort((a, b) => a - b);
  return Math.min(prices[1] ?? reservation, reservation);
}

/**
 * Resolve any open tasks whose deadline has passed (deadline_at <= now).
 * Returns count of newly-resolved tasks (assigned + expired).
 */
export async function resolveAuctions(now: Date = new Date(), ledgerOverride?: Ledger): Promise<{ assigned: number; expired: number }> {
  return withAuctionResolveLock(() => resolveAuctionsUnlocked(now, ledgerOverride));
}

async function resolveAuctionsUnlocked(now: Date, ledgerOverride?: Ledger): Promise<{ assigned: number; expired: number }> {
  const tasks = await readAllInDir(`${MARKET}/tasks`, TaskSchema);
  const bids = await readAllInDir(`${MARKET}/bids`, BidSchema);
  const reservations = await loadReservations();
  const ledger = ledgerOverride ?? await loadLedger();
  let ledgerChanged = false;

  let assigned = 0;
  let expired = 0;

  for (const task of tasks) {
    if (task.status !== "open") continue;
    if (new Date(task.deadline_at) > now) continue; // not past deadline yet

    const reservation = reservations[task.id];
    if (reservation === undefined) {
      console.warn(dim(`  ${task.id}: no reservation price set, skipping`));
      continue;
    }

    const taskBids = bids.filter((b) => b.task_id === task.id);
    const validBids = taskBids
      .filter((b) => b.agent !== task.creator && b.agent !== task.posted_by.replace(/^agent:/, ""))
      .filter((b) => b.price <= reservation && (ledger[b.agent]?.balance ?? 0) > 0)
      .sort((a, b) => a.price - b.price);

    if (validBids.length === 0) {
      const updatedTask: Task = { ...task, status: "expired" };
      await Bun.write(
        `${MARKET}/tasks/${task.id}.json`,
        JSON.stringify(updatedTask, null, 2)
      );
      console.log(
        red(`  ${task.id}: EXPIRED — ${taskBids.length} bid(s), none ≤ reservation ${reservation}`)
      );
      const brief = task.description.replace(/\s+/g, " ").slice(0, 180);
      for (const b of taskBids) {
        const alive = (ledger[b.agent]?.balance ?? 0) > 0;
        const selfBid = b.agent === task.creator || b.agent === task.posted_by.replace(/^agent:/, "");
        const reason = selfBid
          ? `your bid ignored because creators cannot bid on their own tasks`
          : alive ? `your bid ${b.price} above reservation` : `your bid ignored because you are bankrupt`;
        await recordEvent(b.agent, now, `task ${task.id} expired — ${reason}, no payment — ${brief}`);
      }
      const refunded = await refundEscrow(ledger, task.id, `Escrow refund: ${task.id} expired`, now);
      if (refunded > 0) ledgerChanged = true;
      expired++;
      continue;
    }

    const winner = validBids[0];
    const payment = clearingPayment(validBids, reservation);

    // Pre-clone the task repo into the winner's work dir BEFORE we
    // publish the assignment. The watcher's fs.watch on assignments/
    // wakes the agent immediately, and we want the work tree ready by
    // the time their pi process runs.
    try {
      await prepareWorkDir(winner.agent, task);
    } catch (e) {
      console.error(red(`  ${task.id}: prepareWorkDir failed for ${winner.agent}: ${e}`));
      continue;
    }

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
      brightGreen(`  ${task.id}: ${winner.agent} wins (bid ${winner.price}, paid ${payment}, reserve ${reservation}, ${validBids.length} valid bid(s))`)
    );

    const brief = task.description.replace(/\s+/g, " ").slice(0, 180);
    await recordEvent(winner.agent, now, `won task ${task.id} at ${payment} (your bid: ${winner.price}; ${validBids.length} valid bids) — ${brief}`);
    for (const b of taskBids) {
      if (b.agent === winner.agent) continue;
      await recordEvent(b.agent, now, `lost task ${task.id} to ${winner.agent} paid ${payment} (your bid: ${b.price}) — ${brief}`);
    }
    assigned++;
  }

  if (!ledgerOverride && ledgerChanged) {
    await saveLedger(ledger);
    await syncBalances(ledger);
  }

  return { assigned, expired };
}

// Run standalone (settles whatever is past deadline now)
if (import.meta.main) {
  const result = await resolveAuctions();
  console.log(brightYellow(`Exchange: ${result.assigned} assigned, ${result.expired} expired`));
}
