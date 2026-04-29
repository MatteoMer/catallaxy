/**
 * Watch — long-running orchestrator. No rounds.
 *
 * Loop forever:
 *   - Settle any auctions whose deadline has passed
 *   - Process any new reviews
 *   - Detect changes in /market/ and wake interested agents
 *   - Each agent wakeup runs `pi -p` once, debits token cost, records to history
 *
 * Agent wake triggers:
 *   - New open task they haven't bid on
 *   - Bid changed on a task they've bid on (price war)
 *   - New assignment they won
 *   - New review on something they submitted
 *
 * Usage:
 *   bun orchestrator/watch.ts
 */

import { readdir, stat, stat as fsStat } from "node:fs/promises";
import {
  loadLedger, saveLedger, initAgent, debit, syncBalances, aliveAgents,
  extractUsage, recordWakeup, recordEvent, type AgentUsage,
} from "./ledger";
import { resolveAuctions } from "./exchange";
import { processReviewRequests } from "./reviewer";
import { TaskSchema, BidSchema, AssignmentSchema, ReviewRequestSchema, ReviewResponseSchema } from "./schemas";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "./agents";
const MARKET = process.env.MARKET_DIR ?? "./market";
const TICK_MS = parseInt(process.env.TICK_MS ?? "3000", 10);
const MIN_WAKE_INTERVAL_MS = parseInt(process.env.MIN_WAKE_INTERVAL_MS ?? "5000", 10);

async function discoverAgents(): Promise<string[]> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);
}

async function readJsonOrNull<T>(path: string, schema: { parse: (d: unknown) => T }): Promise<T | null> {
  try {
    return schema.parse(await Bun.file(path).json());
  } catch {
    return null;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

async function fileSig(path: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * Capture a snapshot of the market state. Used to detect changes between ticks.
 */
async function snapshotMarket(): Promise<Map<string, string>> {
  const sig = new Map<string, string>();
  for (const dir of ["tasks", "bids", "assignments", "review_requests", "review_responses"]) {
    const files = await listJsonFiles(`${MARKET}/${dir}`);
    for (const f of files) {
      sig.set(`${dir}/${f}`, await fileSig(`${MARKET}/${dir}/${f}`));
    }
  }
  return sig;
}

function diffSnapshots(prev: Map<string, string>, next: Map<string, string>): { added: string[]; changed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of next) {
    if (!prev.has(k)) added.push(k);
    else if (prev.get(k) !== v) changed.push(k);
  }
  return { added, changed };
}

/**
 * Decide which agents should wake based on market changes.
 */
async function agentsToWake(
  agents: string[],
  changes: { added: string[]; changed: string[] }
): Promise<Set<string>> {
  const wakers = new Set<string>();
  const all = [...changes.added, ...changes.changed];
  if (all.length === 0) return wakers;

  for (const path of all) {
    if (path.startsWith("tasks/")) {
      // New or changed task: wake everyone (they may want to bid)
      agents.forEach((a) => wakers.add(a));
    } else if (path.startsWith("bids/")) {
      // Bid change: wake any agent who has bid on this task (price war)
      const bid = await readJsonOrNull(`${MARKET}/${path}`, BidSchema);
      if (!bid) continue;
      // Wake any agent except the one who just bid
      const allBids = await listJsonFiles(`${MARKET}/bids`);
      const interested = new Set<string>();
      for (const f of allBids) {
        const b = await readJsonOrNull(`${MARKET}/bids/${f}`, BidSchema);
        if (b && b.task_id === bid.task_id) interested.add(b.agent);
      }
      // Plus anyone who hasn't bid yet (they may want to)
      agents.forEach((a) => {
        if (a !== bid.agent && (interested.has(a) || true)) wakers.add(a);
      });
    } else if (path.startsWith("assignments/")) {
      const a = await readJsonOrNull(`${MARKET}/${path}`, AssignmentSchema);
      if (a) wakers.add(a.winner);
    } else if (path.startsWith("review_responses/")) {
      const r = await readJsonOrNull(`${MARKET}/${path}`, ReviewResponseSchema);
      if (!r) continue;
      wakers.add(r.agent);
    }
  }
  return wakers;
}

async function gatherWakeupContext(agent: string, since: Date) {
  const ctx = {
    bidsPlaced: [] as { task_id: string; price: number; description: string }[],
    reviewsCalled: [] as { task_id: string; seq: number }[],
  };

  const taskDescriptions: Record<string, string> = {};
  for (const f of await listJsonFiles(`${MARKET}/tasks`)) {
    const t = await readJsonOrNull(`${MARKET}/tasks/${f}`, TaskSchema);
    if (t) taskDescriptions[t.id] = t.description;
  }

  for (const f of await listJsonFiles(`${MARKET}/bids`)) {
    const path = `${MARKET}/bids/${f}`;
    const fileStat = await fsStat(path).catch(() => null);
    if (!fileStat || fileStat.mtimeMs < since.getTime()) continue;
    const b = await readJsonOrNull(path, BidSchema);
    if (b && b.agent === agent) {
      ctx.bidsPlaced.push({
        task_id: b.task_id,
        price: b.price,
        description: taskDescriptions[b.task_id] ?? "(unknown)",
      });
    }
  }

  for (const f of await listJsonFiles(`${MARKET}/review_requests`)) {
    const path = `${MARKET}/review_requests/${f}`;
    const fileStat = await fsStat(path).catch(() => null);
    if (!fileStat || fileStat.mtimeMs < since.getTime()) continue;
    const r = await readJsonOrNull(path, ReviewRequestSchema);
    if (r && r.agent === agent) {
      ctx.reviewsCalled.push({ task_id: r.task_id, seq: r.seq });
    }
  }

  return ctx;
}

function formatRelative(now: Date, target: Date): string {
  const diffMs = target.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const past = diffMs < 0;
  let value: string;
  if (abs < 60_000) value = `${Math.max(1, Math.round(abs / 1000))}s`;
  else if (abs < 3_600_000) value = `${Math.round(abs / 60_000)}m`;
  else if (abs < 86_400_000) value = `${Math.round(abs / 3_600_000)}h`;
  else value = `${Math.round(abs / 86_400_000)}d`;
  return past ? `${value} ago` : `in ${value}`;
}

async function buildWakePrompt(agent: string): Promise<string> {
  const now = new Date();
  type TaskInfo = { id: string; status: string; description: string; review_fee: number; deadline_at: string };
  const tasks: TaskInfo[] = [];
  for (const f of await listJsonFiles(`${MARKET}/tasks`)) {
    const t = await readJsonOrNull(`${MARKET}/tasks/${f}`, TaskSchema);
    if (t) tasks.push({ id: t.id, status: t.status, description: t.description, review_fee: t.review_fee, deadline_at: t.deadline_at });
  }
  const open = tasks.filter((t) => t.status === "open");

  const assignedToMe: TaskInfo[] = [];
  for (const f of await listJsonFiles(`${MARKET}/assignments`)) {
    const a = await readJsonOrNull(`${MARKET}/assignments/${f}`, AssignmentSchema);
    if (!a || a.winner !== agent) continue;
    const task = tasks.find((t) => t.id === a.task_id);
    if (task && task.status === "assigned") assignedToMe.push(task);
  }

  const lines: string[] = [];
  lines.push(`Wakeup at ${now.toISOString()} (UTC). You are ${agent}.`);
  if (open.length) {
    lines.push("Open tasks:");
    for (const t of open) {
      const desc = t.description.length > 90 ? t.description.slice(0, 90) + "…" : t.description;
      const deadline = new Date(t.deadline_at);
      lines.push(`- ${t.id} | fee ${t.review_fee} | deadline ${t.deadline_at} (${formatRelative(now, deadline)}) | ${desc}`);
    }
  } else {
    lines.push("Open tasks: none.");
  }
  if (assignedToMe.length) {
    lines.push("Assigned to you:");
    for (const t of assignedToMe) {
      const desc = t.description.length > 90 ? t.description.slice(0, 90) + "…" : t.description;
      lines.push(`- ${t.id} | ${desc}`);
    }
  }
  return lines.join("\n");
}

function logPrefixed(prefix: string, content: string): void {
  for (const line of content.split("\n")) console.log(`  [${prefix}] ${line}`);
}

function handlePiEvent(agent: string, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let ev: any;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (ev.type !== "turn_end" || !ev.message?.content) return;
  for (const c of ev.message.content) {
    if (c.type === "thinking" && c.thinking) {
      logPrefixed(`${agent}/thinks`, c.thinking);
    } else if (c.type === "text" && c.text) {
      logPrefixed(`${agent}/says`, c.text);
    } else if (c.type === "tool_use") {
      logPrefixed(`${agent}/${c.name}`, JSON.stringify(c.input ?? {}));
    }
  }
}

async function runAgent(agent: string): Promise<string> {
  const prompt = await buildWakePrompt(agent);
  logPrefixed(`${agent}/wake-prompt`, prompt);

  const model = process.env.AGENT_MODEL ?? "openrouter/z-ai/glm-5.1";

  const proc = Bun.spawn([
    "pi",
    "-p", prompt,
    "--model", model,
    "--api-key", process.env.OPENROUTER_API_KEY ?? "",
    "--mode", "json",
    "--no-session",
  ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });

  const decoder = new TextDecoder();
  let buffer = "";
  let captured = "";

  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    captured += text;
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      handlePiEvent(agent, buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.length) handlePiEvent(agent, buffer);

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`  [${agent}] exit ${exitCode}: ${stderr.slice(0, 200)}`);
  }
  return captured;
}

async function wakeAgent(agent: string, ledger: any): Promise<void> {
  const at = new Date();
  console.log(`  → waking ${agent} at ${at.toISOString().slice(11, 19)}`);
  const output = await runAgent(agent);
  const usage = extractUsage(output);
  if (usage.totalTokens > 0) {
    debit(ledger, agent, usage.totalTokens, `Wakeup: ${usage.totalTokens}tok ($${usage.costUsd.toFixed(4)})`, at);
    console.log(`    ${agent}: -${usage.totalTokens.toLocaleString()} tokens ($${usage.costUsd.toFixed(4)})`);
  }
  const ctx = await gatherWakeupContext(agent, at);
  await recordWakeup(agent, at, usage, ctx);
}

async function main() {
  console.log(`Catallaxy watcher: tick ${TICK_MS}ms, min wake interval ${MIN_WAKE_INTERVAL_MS}ms`);

  const agentNames = await discoverAgents();
  console.log(`Agents: ${agentNames.join(", ")}`);

  const systemPrompt = await Bun.file(`${process.cwd()}/SYSTEM.md`)
    .text()
    .catch(() => "(no SYSTEM.md found)");
  logPrefixed("orchestrator/system-prompt", systemPrompt);

  const ledger = await loadLedger();
  for (const name of agentNames) initAgent(ledger, name);
  await saveLedger(ledger);
  await syncBalances(ledger);

  const seenReviewRequests = new Set<string>();
  let snapshot = await snapshotMarket();
  const lastWoken = new Map<string, number>(); // agent -> ms timestamp

  // Initial wake: have agents look at the world once at startup, in parallel
  console.log("Initial wakeup...");
  const initial = aliveAgents(ledger).filter((n) => agentNames.includes(n));
  await Promise.allSettled(
    initial.map(async (a) => {
      await wakeAgent(a, ledger);
      lastWoken.set(a, Date.now());
    })
  );
  await saveLedger(ledger);
  await syncBalances(ledger);
  snapshot = await snapshotMarket();

  // Main loop
  while (true) {
    await Bun.sleep(TICK_MS);

    // 1. Settle expired auctions
    const auctionResult = await resolveAuctions();
    if (auctionResult.assigned + auctionResult.expired > 0) {
      console.log(`Settled: ${auctionResult.assigned} assigned, ${auctionResult.expired} expired`);
    }

    // 2. Process new review requests (debits fee, runs claude -p, credits on LGTM)
    await processReviewRequests(ledger, seenReviewRequests);

    // 3. Detect changes
    const next = await snapshotMarket();
    const changes = diffSnapshots(snapshot, next);
    snapshot = next;

    if (changes.added.length === 0 && changes.changed.length === 0) {
      continue;
    }

    // 4. Wake affected agents
    const alive = aliveAgents(ledger).filter((n) => agentNames.includes(n));
    const wakers = await agentsToWake(alive, changes);
    if (wakers.size > 0) {
      console.log(`Changes detected (${changes.added.length} added, ${changes.changed.length} changed) — waking ${[...wakers].join(", ")}`);
    }

    // Apply min wake interval to prevent runaway loops
    const now = Date.now();
    const toWake = [...wakers].filter((a) => {
      const last = lastWoken.get(a) ?? 0;
      return now - last >= MIN_WAKE_INTERVAL_MS;
    });

    // Wake them in parallel
    await Promise.allSettled(
      toWake.map(async (a) => {
        await wakeAgent(a, ledger);
        lastWoken.set(a, Date.now());
      })
    );

    // 5. Save & sync
    await saveLedger(ledger);
    await syncBalances(ledger);
    snapshot = await snapshotMarket(); // refresh after agents acted

    // 6. Status
    for (const agent of agentNames) {
      const bal = ledger[agent]?.balance ?? 0;
      if (bal <= 0) {
        await recordEvent(agent, new Date(), "BANKRUPT — balance hit 0");
      }
    }
  }
}

main().catch((e) => {
  console.error("Watcher error:", e);
  process.exit(1);
});
