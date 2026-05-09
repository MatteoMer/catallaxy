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

import { readdir, stat as fsStat, mkdir, rename, symlink, lstat, rm, unlink } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import {
  loadLedger, saveLedger, initAgent, debit, syncBalances, aliveAgents,
  recordWakeup, recordEvent, flushPendingSummaries,
  type AgentUsage, type Ledger,
} from "./ledger";
import { resolveAuctions } from "./exchange";
import { processReviewRequests } from "./reviewer";
import { reopenUnsolvableAssignments } from "./reopen";
import { TaskSchema, BidSchema, AssignmentSchema, ReviewRequestSchema, ReviewResponseSchema } from "./schemas";
import { startRpcServer } from "./rpc/server";
import { spawnAgent, ensureAgentNetwork } from "./spawnAgent";
import { startProxyServer } from "./proxy/server";
import { writeAgentConfig } from "./proxy/agentConfig";
import { startGateway, stopGateway } from "./gateway";
import { generateTokens, REVIEWER_PRINCIPAL, type TokenMap } from "./auth";
import { dim, gray, cyan, magenta, brightMagenta, yellow, brightYellow, red, brightRed, green, brightGreen, bold, blue } from "./log";
import { renderMarkdownTables } from "./markdown";
import { logEvent } from "./events";

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
  // Remove market symlink if present from older layouts. Agents interact
  // with the market only via pi tools (list_tasks, place_bid, etc.) — they
  // have no direct filesystem access to market state.
  // Use unlink (not rm) because the symlink resolves to a directory and rm
  // would try to operate on the target, returning EACCES.
  const linkMarket = `${sandboxDir}/market`;
  if (await existsLink(linkMarket)) {
    await unlink(linkMarket);
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

async function loadLatestVerdict(taskId: string, agent: string): Promise<{ seq: number; verdict: string; feedback: string } | null> {
  const dir = `${MARKET}/review_responses`;
  let files: string[];
  try { files = await readdir(dir); } catch { return null; }
  let latest: { seq: number; verdict: string; feedback: string } | null = null;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    if (!f.startsWith(`${taskId}-${agent}-`)) continue;
    const r = await readJsonOrNull(`${dir}/${f}`, ReviewResponseSchema);
    if (!r) continue;
    if (!latest || r.seq > latest.seq) latest = { seq: r.seq, verdict: r.verdict, feedback: r.feedback };
  }
  return latest;
}

interface WakePlan {
  prompt: string;
  tools: string[];
  kind: "bid" | "work";
  taskId?: string;
}

async function buildWakePlan(agent: string): Promise<WakePlan> {
  const now = new Date();
  const openIds: string[] = [];
  for (const f of await listJsonFiles(`${MARKET}/tasks`)) {
    const t = await readJsonOrNull(`${MARKET}/tasks/${f}`, TaskSchema);
    if (t && t.status === "open") openIds.push(t.id);
  }
  const assignedIds: string[] = [];
  for (const f of await listJsonFiles(`${MARKET}/assignments`)) {
    const a = await readJsonOrNull(`${MARKET}/assignments/${f}`, AssignmentSchema);
    if (!a || a.winner !== agent) continue;
    const t = await readJsonOrNull(`${MARKET}/tasks/${a.task_id}.json`, TaskSchema);
    if (t && t.status === "assigned") assignedIds.push(a.task_id);
  }

  const lines: string[] = [];
  lines.push(`Wakeup at ${now.toISOString()} (UTC). You are ${agent}.`);
  lines.push("Primary objective: your goal is to grow your balance, don't work at a loss.");

  if (assignedIds.length > 0) {
    const focus = assignedIds[0];
    lines.push(`Wake type: WORK. Focus only on assigned task ${focus}.`);
    lines.push(`Other assigned tasks: ${assignedIds.slice(1).join(", ") || "none"}.`);
    lines.push("Do not inspect open auctions and do not bid during a work wake. Finish or advance the focused assignment, request review when ready, then stop.");
    const v = await loadLatestVerdict(focus, agent);
    if (!v) {
      lines.push(`${focus}: no review yet — do the work and call request_review when ready.`);
    } else if (v.verdict === "needs_work") {
      lines.push(`${focus}: review #${v.seq} → NEEDS WORK. Feedback:`);
      for (const fl of v.feedback.split("\n")) lines.push(`  ${fl}`);
    } else {
      lines.push(`${focus}: review #${v.seq} → ${v.verdict}.`);
    }
    lines.push("");
    lines.push("Enabled tools this wake:");
    lines.push("  my_assignments, task_info, task_verdicts, request_review, my_balance, history");
    lines.push("  read, bash, edit, write for implementation work inside your sandbox");
    lines.push("");
    lines.push("Cash discipline: your balance is debited after every model turn. If it hits 0 mid-wake, the wake is aborted and you are bankrupt. Keep this work wake short; don't keep spending into a negative-net assignment.");
    return {
      kind: "work",
      taskId: focus,
      prompt: lines.join("\n"),
      tools: ["my_assignments", "task_info", "task_verdicts", "request_review", "my_balance", "history", "read", "bash", "edit", "write"],
    };
  }

  lines.push("Wake type: BID. You have no active assignment to work on.");
  lines.push(`Open auctions: ${openIds.length ? openIds.join(", ") : "none"}.`);
  lines.push("The open-auction list above is only a snapshot. Call list_tasks before bidding; new auctions may have appeared since this wake started.");
  lines.push("");
  lines.push("Enabled tools this wake:");
  lines.push("  list_tasks, task_info, place_bid, my_balance, history");
  lines.push("Implementation tools and review tools are disabled during bid wakes. Do not do task work before assignment.");
  lines.push("");
  lines.push("Before bidding: call `history` and read EVERY line — both per-task summaries and individual `Wakeup cost: N tokens` lines. Thinking tokens dominate. Bid above expected TOTAL cost including losing-auction/search attrition. Goal: grow balance, not win auctions; don't work at a loss.");
  lines.push("Cash discipline: your balance is debited after every model turn. If it hits 0 mid-wake, the wake is aborted and you are bankrupt. Place at most a few bids, then stop.");
  return {
    kind: "bid",
    prompt: lines.join("\n"),
    tools: ["list_tasks", "task_info", "place_bid", "my_balance", "history"],
  };
}

function logPrefixed(prefix: string, content: string, color: (s: string) => string = (s) => s): void {
  const tag = color(`[${prefix}]`);
  for (const line of content.split("\n")) console.log(`  ${tag} ${line}`);
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
      logPrefixed(`${agent}/thinks`, c.thinking, gray);
    } else if (c.type === "text" && c.text) {
      logPrefixed(`${agent}/says`, renderMarkdownTables(c.text), cyan);
    } else if (c.type === "tool_use") {
      logPrefixed(`${agent}/${c.name}`, JSON.stringify(c.input ?? {}), green);
    }
  }
}

let wakeCounter = 0;

function usageFromTurnEnd(line: string): AgentUsage | null {
  try {
    const ev = JSON.parse(line);
    if (ev.type !== "turn_end" || !ev.message?.usage) return null;
    const u = ev.message.usage;
    return {
      inputTokens: u.input ?? 0,
      outputTokens: u.output ?? 0,
      cacheReadTokens: u.cacheRead ?? 0,
      totalTokens: u.totalTokens ?? 0,
      costUsd: u.cost?.total ?? 0,
    };
  } catch {
    return null;
  }
}

function addUsage(a: AgentUsage, b: AgentUsage): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.totalTokens += b.totalTokens;
  a.costUsd += b.costUsd;
}

interface BankruptcyInfo {
  at: Date;
  wakeId?: string;
  kind?: "bid" | "work";
  taskId?: string;
  source: "turn_debit" | "check";
  balanceBefore?: number;
  balanceAfter: number;
  debitTokens?: number;
  debitCostUsd?: number;
}

type BankruptcyRecorder = (agent: string, info: BankruptcyInfo) => Promise<void>;

async function runAgent(
  agent: string,
  ledger: Ledger,
  tokens: TokenMap,
  recordBankruptcy?: BankruptcyRecorder
): Promise<AgentUsage> {
  const plan = await buildWakePlan(agent);
  logPrefixed(`${agent}/wake-prompt`, plan.prompt, magenta);

  const wakeId = `w${++wakeCounter}`;
  const model = process.env.AGENT_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";
  await logEvent({
    type: "wake_start",
    agent,
    wake_id: wakeId,
    kind: plan.kind,
    task_id: plan.taskId,
    model,
    tools: plan.tools,
  });

  const token = tokens.byAgent.get(agent);
  if (!token) throw new Error(`no auth token for agent '${agent}'`);
  const proc = spawnAgent({
    agent,
    prompt: plan.prompt,
    model,
    tools: plan.tools,
    authToken: token,
    runTag: wakeId,
  });

  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0 };
  const decoder = new TextDecoder();
  let buffer = "";
  let abortedForBankruptcy = false;

  const processLine = async (line: string) => {
    handlePiEvent(agent, line);
    const turnUsage = usageFromTurnEnd(line);
    if (!turnUsage || turnUsage.totalTokens <= 0) return;
    addUsage(usage, turnUsage);
    const at = new Date();
    const balanceBefore = ledger[agent]?.balance ?? 0;
    debit(ledger, agent, turnUsage.totalTokens, `Wakeup turn: ${turnUsage.totalTokens}tok ($${turnUsage.costUsd.toFixed(4)})`, at);
    const balanceAfter = ledger[agent]?.balance ?? 0;
    console.log(dim(`    ${agent}: -${turnUsage.totalTokens.toLocaleString()} turn tokens ($${turnUsage.costUsd.toFixed(4)}), balance ${balanceAfter.toLocaleString()}`));
    await logEvent({
      type: "turn_debit",
      at: at.toISOString(),
      agent,
      wake_id: wakeId,
      kind: plan.kind,
      task_id: plan.taskId,
      tokens: turnUsage.totalTokens,
      input_tokens: turnUsage.inputTokens,
      output_tokens: turnUsage.outputTokens,
      cache_read_tokens: turnUsage.cacheReadTokens,
      cost_usd: turnUsage.costUsd,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
    });
    await saveLedger(ledger);
    await syncBalances(ledger);
    if (balanceAfter <= 0 && !abortedForBankruptcy) {
      abortedForBankruptcy = true;
      await recordBankruptcy?.(agent, {
        at,
        wakeId,
        kind: plan.kind,
        taskId: plan.taskId,
        source: "turn_debit",
        balanceBefore,
        balanceAfter,
        debitTokens: turnUsage.totalTokens,
        debitCostUsd: turnUsage.costUsd,
      });
      console.log(brightRed(`    ${agent}: bankrupt mid-wake; aborting ${plan.kind} wake`));
      try { proc.kill("SIGTERM"); } catch {}
    }
  };

  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      await processLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.length) await processLine(buffer);

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  await logEvent({
    type: "wake_end",
    agent,
    wake_id: wakeId,
    kind: plan.kind,
    task_id: plan.taskId,
    status: abortedForBankruptcy ? "bankrupt" : exitCode === 0 ? "ok" : "error",
    exit_code: exitCode,
    total_tokens: usage.totalTokens,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cost_usd: usage.costUsd,
    balance_after: ledger[agent]?.balance ?? null,
  });
  if (exitCode !== 0 && !abortedForBankruptcy) {
    console.error(red(`  [${agent}] exit ${exitCode}: ${stderr.slice(0, 200)}`));
  }
  return usage;
}

async function wakeAgent(agent: string, ledger: Ledger, tokens: TokenMap, recordBankruptcy?: BankruptcyRecorder): Promise<void> {
  const at = new Date();
  console.log(brightMagenta(`  → waking ${agent} at ${at.toISOString().slice(11, 19)}`));
  const usage = await runAgent(agent, ledger, tokens, recordBankruptcy);
  if (usage.totalTokens > 0) {
    console.log(dim(`    ${agent}: wake total -${usage.totalTokens.toLocaleString()} tokens ($${usage.costUsd.toFixed(4)})`));
  }
  const ctx = await gatherWakeupContext(agent, at);
  await recordWakeup(agent, at, usage, ctx);
  // Now that this wake's debit has posted, flush any task-completion
  // summaries that were deferred while this wake was in flight.
  await flushPendingSummaries(ledger, agent, new Date());
}

async function main() {
  console.log(bold(`Catallaxy watcher: event-driven (min wake interval ${MIN_WAKE_INTERVAL_MS}ms, reconcile every ${RECONCILE_MS}ms)`));

  const agentNames = await discoverAgents();
  console.log(cyan(`Agents: ${agentNames.join(", ")}`));
  await logEvent({
    type: "watcher_start",
    min_wake_interval_ms: MIN_WAKE_INTERVAL_MS,
    reconcile_ms: RECONCILE_MS,
    agents: agentNames,
  });

  for (const a of agentNames) await ensureSandbox(a);

  await ensureAgentNetwork();
  const tokens = generateTokens(agentNames);
  for (const agent of agentNames) {
    const tok = tokens.byAgent.get(agent)!;
    await writeAgentConfig(agent, tok);
  }
  const rpc = await startRpcServer(tokens);
  const proxy = await startProxyServer(tokens);
  await startGateway();
  const shutdown = async () => {
    try { await stopGateway(); } catch {}
    try { await proxy.stop(); } catch {}
    try { await rpc.stop(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const systemPrompt = await Bun.file(`${process.cwd()}/SYSTEM.md`)
    .text()
    .catch(() => "(no SYSTEM.md found)");
  logPrefixed("orchestrator/system-prompt", systemPrompt, dim);

  const ledger = await loadLedger();
  for (const name of agentNames) initAgent(ledger, name);
  await saveLedger(ledger);
  await syncBalances(ledger);

  // Ensure market subdirs exist before fs.watch attaches
  for (const sub of ["tasks", "bids", "assignments", "review_requests", "review_responses", "pending_summaries"]) {
    await mkdir(`${MARKET}/${sub}`, { recursive: true });
  }

  const seenReviewRequests = new Set<string>();
  const deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const wakeStatus = new Map<string, "running" | "pending">();
  const lastWoken = new Map<string, number>();

  // Serialize processReviewRequests calls so two concurrent fs.watch
  // events for the same review_request file can't double-process it.
  let reviewQueue: Promise<void> = Promise.resolve();
  const safeProcessReviews = (): Promise<void> => {
    reviewQueue = reviewQueue.then(async () => {
      try {
        await processReviewRequests(ledger, seenReviewRequests, tokens.byAgent.get(REVIEWER_PRINCIPAL)!);
        await persist();
      } catch (e) {
        console.error("processReviewRequests error:", e);
      }
    });
    return reviewQueue;
  };

  const persist = async () => {
    await saveLedger(ledger);
    await syncBalances(ledger);
  };

  // Agents that are already dead at watcher startup should not get a fresh
  // BANKRUPT history entry every reconcile tick. New crossings are recorded
  // once via recordBankruptcyOnce below.
  const bankruptRecorded = new Set(agentNames.filter((agent) => (ledger[agent]?.balance ?? 0) <= 0));

  const recordBankruptcyOnce: BankruptcyRecorder = async (agent, info) => {
    if (bankruptRecorded.has(agent)) return;
    bankruptRecorded.add(agent);
    await logEvent({
      type: "bankrupt",
      at: info.at.toISOString(),
      agent,
      wake_id: info.wakeId,
      kind: info.kind,
      task_id: info.taskId,
      source: info.source,
      balance_before: info.balanceBefore,
      balance_after: info.balanceAfter,
      debit_tokens: info.debitTokens,
      debit_cost_usd: info.debitCostUsd,
      last_ledger_entries: ledger[agent]?.history.slice(-8) ?? [],
    });
    await recordEvent(agent, info.at, "BANKRUPT — balance hit 0");
  };

  const checkBankrupt = async () => {
    for (const agent of agentNames) {
      const bal = ledger[agent]?.balance ?? 0;
      if (bal <= 0) await recordBankruptcyOnce(agent, {
        at: new Date(),
        source: "check",
        balanceAfter: bal,
      });
    }
  };

  /**
   * Coalescing wake trigger:
   * - At most one wake in flight per agent.
   * - `queueIfRunning` controls behavior when a wake is already in flight:
   *     true  → set pending; fire a follow-up wake after current completes.
   *             Use for actionable events (assignment, review_response) the
   *             agent must react to.
   *     false → drop the trigger. The running wake's tools can read live
   *             market state, so it already covers refresh-style events
   *             (new task, new bid). Avoids duplicate wakes for events the
   *             current wake already handled.
   * - Respects MIN_WAKE_INTERVAL_MS between consecutive wakes.
   * - Never throws.
   */
  const triggerWake = async (agent: string, queueIfRunning: boolean = true): Promise<void> => {
    if (!agentNames.includes(agent)) return;
    if ((ledger[agent]?.balance ?? 0) <= 0) return;

    const status = wakeStatus.get(agent);
    if (status === "pending") return;
    if (status === "running") {
      if (queueIfRunning) wakeStatus.set(agent, "pending");
      return;
    }

    const wait = Math.max(0, MIN_WAKE_INTERVAL_MS - (Date.now() - (lastWoken.get(agent) ?? 0)));
    if (wait > 0) {
      setTimeout(() => { triggerWake(agent, queueIfRunning); }, wait);
      return;
    }

    wakeStatus.set(agent, "running");
    try {
      await wakeAgent(agent, ledger, tokens, recordBankruptcyOnce);
      lastWoken.set(agent, Date.now());
      await persist();
      await checkBankrupt();
    } catch (e) {
      console.error(`wake error for ${agent}:`, e);
    } finally {
      const wasPending = wakeStatus.get(agent) === "pending";
      wakeStatus.delete(agent);
      if (wasPending) triggerWake(agent, true);
    }
  };

  const settleAndPersist = async () => {
    try {
      const r = await resolveAuctions();
      if (r.assigned + r.expired > 0) {
        console.log(brightYellow(`Settled: ${r.assigned} assigned, ${r.expired} expired`));
      }
    } catch (e) {
      console.error("resolveAuctions error:", e);
    }

    try {
      const r = await reopenUnsolvableAssignments(ledger);
      if (r.reopened.length > 0) {
        console.log(brightYellow(`Reopened bankrupt assignment(s): ${r.reopened.join(", ")}`));
        for (const a of aliveAgents(ledger).filter((n) => agentNames.includes(n))) {
          triggerWake(a, false);
        }
      }
    } catch (e) {
      console.error("reopenUnsolvableAssignments error:", e);
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
    console.log(dim(`scheduled settle for ${task.id} ${formatRelative(new Date(), new Date(task.deadline_at))}`));
  };

  // Watcher infrastructure
  const knownFiles = new Map<string, Set<string>>();

  const handleAdded = async (subdir: string, file: string): Promise<void> => {
    const fullPath = `${MARKET}/${subdir}/${file}`;
    if (subdir === "tasks") {
      const t = await readJsonOrNull(fullPath, TaskSchema);
      if (!t) return;
      console.log(yellow(`new task: ${t.id}`));
      scheduleDeadline(t);
      for (const a of agentNames) triggerWake(a, false);
    } else if (subdir === "bids") {
      // Don't wake other agents on bid events. Each wake costs tokens
      // and the value of "react to a competitor's bid" is small —
      // agents can see live state via the list_tasks tool if they care.
      const b = await readJsonOrNull(fullPath, BidSchema);
      if (!b) return;
    } else if (subdir === "assignments") {
      const a = await readJsonOrNull(fullPath, AssignmentSchema);
      if (!a) return;
      triggerWake(a.winner, true);
    } else if (subdir === "review_requests") {
      const r = await readJsonOrNull(fullPath, ReviewRequestSchema);
      if (!r) return;
      await safeProcessReviews();
    } else if (subdir === "review_responses") {
      const r = await readJsonOrNull(fullPath, ReviewResponseSchema);
      if (!r) return;
      // Only wake on needs_work — LGTM closes the task and there's nothing
      // for the agent to react to. Saves an unnecessary wake's tokens.
      if (r.verdict === "needs_work") triggerWake(r.agent, true);
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
  await safeProcessReviews();

  // Attach watchers
  for (const sub of ["tasks", "bids", "assignments", "review_requests", "review_responses"]) {
    await watchSubdir(sub);
  }
  console.log(green("Watchers attached."));

  // Replay existing actionable state as events.
  // - Active assignments wake their winner (must react, queue if running).
  // - Existing open auctions only wake everyone if at least one has no bids.
  //   This makes watcher restarts cheap: a restart should not re-trigger a
  //   whole-market bidding wake when agents already saw and bid on the opens.
  const bidFiles = await listJsonFiles(`${MARKET}/bids`);
  let anyUnbidOpen = false;
  for (const f of await listJsonFiles(`${MARKET}/tasks`)) {
    const t = await readJsonOrNull(`${MARKET}/tasks/${f}`, TaskSchema);
    if (t && t.status === "open" && !bidFiles.some((b) => b.startsWith(`${t.id}-`))) {
      anyUnbidOpen = true;
      break;
    }
  }
  if (anyUnbidOpen) {
    for (const a of aliveAgents(ledger).filter((n) => agentNames.includes(n))) {
      triggerWake(a, false);
    }
  }
  for (const f of await listJsonFiles(`${MARKET}/assignments`)) {
    const ass = await readJsonOrNull(`${MARKET}/assignments/${f}`, AssignmentSchema);
    if (!ass) continue;
    const t = await readJsonOrNull(`${MARKET}/tasks/${ass.task_id}.json`, TaskSchema);
    if (t && t.status === "assigned") triggerWake(ass.winner, true);
  }
  console.log(dim("Idling for events."));

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
      await safeProcessReviews();
      // Safety net: if an agent's last wake already debited but the flush
      // call inside wakeAgent somehow missed a marker (or the marker was
      // written after the wake ended), catch it here. Skip agents with a
      // wake in flight to avoid attributing an unrelated wake's cost to a
      // completed task.
      for (const agent of agentNames) {
        if (wakeStatus.has(agent)) continue;
        await flushPendingSummaries(ledger, agent, new Date());
      }
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
