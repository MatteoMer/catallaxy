/**
 * Watch — long-running event-driven orchestrator.
 *
 * Auction settlement: setTimeout per open task fires at deadline_at exactly
 * (no polling lag).
 * Wake triggers: fs.watch on /market/{tasks,bids,assignments,review_requests,
 *   review_responses}/. New files dispatch to per-event handlers that wake
 *   relevant agents or call processReviewRequests.
 * Wake debounce: at most one wake per agent in flight; multiple events
 *   coalesce into a single follow-up; MIN_WAKE_INTERVAL_MS between wakes.
 * Reconciler: periodic safety net (every RECONCILE_MS) re-schedules timers
 *   and re-runs settlement / review processing in case the watcher missed
 *   an event (macOS fs.watch is occasionally unreliable on renames).
 *
 * Usage: bun orchestrator/watch.ts
 */

import { readdir, stat as fsStat, mkdir, rename, symlink, lstat, rm } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import {
  loadLedger, saveLedger, initAgent, debit, syncBalances, aliveAgents,
  extractUsage, recordWakeup, recordEvent, type AgentUsage, type Ledger,
} from "./ledger";
import { resolveAuctions } from "./exchange";
import { processReviewRequests } from "./reviewer";
import { TaskSchema, BidSchema, AssignmentSchema, ReviewRequestSchema, ReviewResponseSchema } from "./schemas";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "./agents";
const MARKET = process.env.MARKET_DIR ?? "./market";
const MIN_WAKE_INTERVAL_MS = parseInt(process.env.MIN_WAKE_INTERVAL_MS ?? "5000", 10);
const RECONCILE_MS = parseInt(process.env.RECONCILE_MS ?? "60000", 10);

async function discoverAgents(): Promise<string[]> {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);
}

/**
 * Ensure each agent has a sandbox at agents/{name}/sandbox/ with:
 * - SYSTEM.md and market symlinked to the catallaxy root (read access).
 * - memory/ and work/ dirs (writable).
 * - identity.json (migrated from agents/{name}/ if it lived there in the old layout).
 */
async function ensureSandbox(agent: string): Promise<void> {
  const agentDir = `${AGENTS_DIR}/${agent}`;
  const sandboxDir = `${agentDir}/sandbox`;

  await mkdir(sandboxDir, { recursive: true });
  await mkdir(`${sandboxDir}/memory`, { recursive: true });
  await mkdir(`${sandboxDir}/work`, { recursive: true });

  const parentIdentity = `${agentDir}/identity.json`;
  const sandboxIdentity = `${sandboxDir}/identity.json`;
  if (existsSync(parentIdentity) && !existsSync(sandboxIdentity)) {
    await rename(parentIdentity, sandboxIdentity);
  }

  for (const stale of ["balance.json", "memory", "work"]) {
    const path = `${agentDir}/${stale}`;
    if (existsSync(path)) await rm(path, { recursive: true, force: true });
  }

  const linkSysmd = `${sandboxDir}/SYSTEM.md`;
  if (!(await existsLink(linkSysmd))) {
    await symlink("../../../SYSTEM.md", linkSysmd);
  }
  const linkMarket = `${sandboxDir}/market`;
  if (!(await existsLink(linkMarket))) {
    await symlink("../../../market", linkMarket);
  }
}

async function existsLink(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
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
    lines.push("Open auctions — BID ONLY, do NOT start the work yet (read the task, write a bid file, that's it):");
    for (const t of open) {
      const deadline = new Date(t.deadline_at);
      lines.push(`- ${t.id} | fee ${t.review_fee} | auction settles ${formatRelative(now, deadline)} at ${t.deadline_at} | ${t.description}`);
    }
  } else {
    lines.push("Open tasks: none.");
  }
  if (assignedToMe.length) {
    lines.push("Assigned to you — you won, NOW do the work (clone repo into work/{task-id}/, implement, call review):");
    for (const t of assignedToMe) {
      lines.push(`- ${t.id} | ${t.description}`);
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
  ], { cwd: `${process.cwd()}/${AGENTS_DIR}/${agent}/sandbox`, stdout: "pipe", stderr: "pipe" });

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

async function wakeAgent(agent: string, ledger: Ledger): Promise<void> {
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
  console.log(`Catallaxy watcher: event-driven (min wake interval ${MIN_WAKE_INTERVAL_MS}ms, reconcile every ${RECONCILE_MS}ms)`);

  const agentNames = await discoverAgents();
  console.log(`Agents: ${agentNames.join(", ")}`);

  for (const a of agentNames) await ensureSandbox(a);

  const systemPrompt = await Bun.file(`${process.cwd()}/SYSTEM.md`)
    .text()
    .catch(() => "(no SYSTEM.md found)");
  logPrefixed("orchestrator/system-prompt", systemPrompt);

  const ledger = await loadLedger();
  for (const name of agentNames) initAgent(ledger, name);
  await saveLedger(ledger);
  await syncBalances(ledger);

  // Ensure market subdirs exist before fs.watch attaches
  for (const sub of ["tasks", "bids", "assignments", "review_requests", "review_responses"]) {
    await mkdir(`${MARKET}/${sub}`, { recursive: true });
  }

  const seenReviewRequests = new Set<string>();
  const deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const wakeStatus = new Map<string, "running" | "pending">();
  const lastWoken = new Map<string, number>();

  const persist = async () => {
    await saveLedger(ledger);
    await syncBalances(ledger);
  };

  const checkBankrupt = async () => {
    for (const agent of agentNames) {
      const bal = ledger[agent]?.balance ?? 0;
      if (bal <= 0) await recordEvent(agent, new Date(), "BANKRUPT — balance hit 0");
    }
  };

  /**
   * Coalescing wake trigger:
   * - At most one wake in flight per agent.
   * - Multiple triggers during a wake collapse into a single follow-up.
   * - Respects MIN_WAKE_INTERVAL_MS between consecutive wakes.
   * - Never throws.
   */
  const triggerWake = async (agent: string): Promise<void> => {
    if (!agentNames.includes(agent)) return;
    if ((ledger[agent]?.balance ?? 0) <= 0) return;

    const status = wakeStatus.get(agent);
    if (status === "pending") return;
    if (status === "running") {
      wakeStatus.set(agent, "pending");
      return;
    }

    const wait = Math.max(0, MIN_WAKE_INTERVAL_MS - (Date.now() - (lastWoken.get(agent) ?? 0)));
    if (wait > 0) {
      setTimeout(() => { triggerWake(agent); }, wait);
      return;
    }

    wakeStatus.set(agent, "running");
    try {
      await wakeAgent(agent, ledger);
      lastWoken.set(agent, Date.now());
      await persist();
      await checkBankrupt();
    } catch (e) {
      console.error(`wake error for ${agent}:`, e);
    } finally {
      const wasPending = wakeStatus.get(agent) === "pending";
      wakeStatus.delete(agent);
      if (wasPending) triggerWake(agent);
    }
  };

  const settleAndPersist = async () => {
    try {
      const r = await resolveAuctions();
      if (r.assigned + r.expired > 0) {
        console.log(`Settled: ${r.assigned} assigned, ${r.expired} expired`);
      }
    } catch (e) {
      console.error("resolveAuctions error:", e);
    }
    await persist();
  };

  const scheduleDeadline = (task: { id: string; deadline_at: string; status: string }) => {
    const existing = deadlineTimers.get(task.id);
    if (existing) clearTimeout(existing);
    if (task.status !== "open") {
      deadlineTimers.delete(task.id);
      return;
    }
    const ms = Math.max(0, new Date(task.deadline_at).getTime() - Date.now());
    const t = setTimeout(async () => {
      deadlineTimers.delete(task.id);
      await settleAndPersist();
    }, ms);
    deadlineTimers.set(task.id, t);
    console.log(`scheduled settle for ${task.id} ${formatRelative(new Date(), new Date(task.deadline_at))}`);
  };

  // Watcher infrastructure
  const knownFiles = new Map<string, Set<string>>();

  const handleAdded = async (subdir: string, file: string): Promise<void> => {
    const fullPath = `${MARKET}/${subdir}/${file}`;
    if (subdir === "tasks") {
      const t = await readJsonOrNull(fullPath, TaskSchema);
      if (!t) return;
      console.log(`new task: ${t.id}`);
      scheduleDeadline(t);
      for (const a of agentNames) triggerWake(a);
    } else if (subdir === "bids") {
      const b = await readJsonOrNull(fullPath, BidSchema);
      if (!b) return;
      for (const a of agentNames) {
        if (a !== b.agent) triggerWake(a);
      }
    } else if (subdir === "assignments") {
      const a = await readJsonOrNull(fullPath, AssignmentSchema);
      if (!a) return;
      triggerWake(a.winner);
    } else if (subdir === "review_requests") {
      try {
        await processReviewRequests(ledger, seenReviewRequests);
        await persist();
      } catch (e) {
        console.error("processReviewRequests error:", e);
      }
    } else if (subdir === "review_responses") {
      const r = await readJsonOrNull(fullPath, ReviewResponseSchema);
      if (!r) return;
      triggerWake(r.agent);
    }
  };

  const handleChanged = async (subdir: string, file: string): Promise<void> => {
    if (subdir === "tasks") {
      const t = await readJsonOrNull(`${MARKET}/${subdir}/${file}`, TaskSchema);
      if (t) scheduleDeadline(t);
    }
  };

  const watchSubdir = async (subdir: string) => {
    const dir = `${MARKET}/${subdir}`;
    const initial = new Set((await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")));
    knownFiles.set(subdir, initial);

    const w = watch(dir, async (eventType) => {
      try {
        const current = new Set((await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")));
        const known = knownFiles.get(subdir)!;
        for (const f of current) {
          if (!known.has(f)) {
            known.add(f);
            await handleAdded(subdir, f);
          } else if (eventType === "change") {
            await handleChanged(subdir, f);
          }
        }
        for (const f of [...known]) {
          if (!current.has(f)) known.delete(f);
        }
      } catch (e) {
        console.error(`watch ${subdir} error:`, e);
      }
    });
    w.on("error", (err) => console.error(`watch ${subdir}:`, err));
  };

  // Schedule deadlines for any existing open tasks
  for (const f of await listJsonFiles(`${MARKET}/tasks`)) {
    const t = await readJsonOrNull(`${MARKET}/tasks/${f}`, TaskSchema);
    if (t) scheduleDeadline(t);
  }

  // Settle any already-expired auctions on startup, process pending reviews
  await settleAndPersist();
  await processReviewRequests(ledger, seenReviewRequests);
  await persist();

  // Attach watchers BEFORE initial wake so that bids placed during the
  // initial wake fire handlers naturally (price-war wakeups).
  for (const sub of ["tasks", "bids", "assignments", "review_requests", "review_responses"]) {
    await watchSubdir(sub);
  }
  console.log("Watchers attached.");

  // Initial wake of all alive agents
  console.log("Initial wakeup...");
  const initialAgents = aliveAgents(ledger).filter((n) => agentNames.includes(n));
  await Promise.allSettled(initialAgents.map((a) => triggerWake(a)));
  console.log("Initial wakeup complete. Idling for events.");

  // Periodic reconciler — safety net for missed file events
  setInterval(async () => {
    try {
      for (const f of await listJsonFiles(`${MARKET}/tasks`)) {
        const t = await readJsonOrNull(`${MARKET}/tasks/${f}`, TaskSchema);
        if (t && t.status === "open" && !deadlineTimers.has(t.id)) {
          scheduleDeadline(t);
        }
      }
      await settleAndPersist();
      await processReviewRequests(ledger, seenReviewRequests);
      await persist();
      await checkBankrupt();
    } catch (e) {
      console.error("reconcile error:", e);
    }
  }, RECONCILE_MS);

  // Block forever — handlers do all the work
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("Watcher error:", e);
  process.exit(1);
});
