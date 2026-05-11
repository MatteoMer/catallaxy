/**
 * Ledger — balance management for all agents.
 *
 * Single source of truth. Agents only see their own balance.json.
 * The orchestrator reads/writes the full ledger.
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { LedgerSchema, BalanceSchema, type Ledger, type Balance } from "./schemas";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "./agents";
const LEDGER_PATH = process.env.LEDGER_PATH ?? "./orchestrator/ledger.json";
const MARKET = process.env.MARKET_DIR ?? "./market";
const PENDING_SUMMARIES_DIR = `${MARKET}/pending_summaries`;
// History lives outside the agent's sandbox so the agent's pi process
// has no filesystem path to write it. Agents read history via the
// `history` tool exposed by extensions/catallaxy.ts.
const HISTORY_DIR = process.env.AGENT_HISTORY_DIR ?? "./orchestrator/private/history";

export async function loadLedger(): Promise<Ledger> {
  try {
    const raw = await Bun.file(LEDGER_PATH).json();
    return LedgerSchema.parse(raw);
  } catch {
    return {};
  }
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  await Bun.write(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

export function initAgent(ledger: Ledger, name: string, startingBalance = 1_000_000): void {
  if (!ledger[name]) {
    ledger[name] = { balance: startingBalance, history: [] };
  }
}

export function debit(
  ledger: Ledger,
  agent: string,
  amount: number,
  description: string,
  at: Date = new Date()
): void {
  const entry = ledger[agent];
  if (!entry) return;
  entry.balance -= amount;
  entry.history.push({ at: at.toISOString(), type: "debit_thinking", amount, description });
}

export function debitReviewFee(
  ledger: Ledger,
  agent: string,
  amount: number,
  description: string,
  at: Date = new Date()
): void {
  const entry = ledger[agent];
  if (!entry) return;
  entry.balance -= amount;
  entry.history.push({ at: at.toISOString(), type: "debit_review_fee", amount, description });
}

export function credit(
  ledger: Ledger,
  agent: string,
  amount: number,
  description: string,
  at: Date = new Date()
): void {
  const entry = ledger[agent];
  if (!entry) return;
  entry.balance += amount;
  entry.history.push({ at: at.toISOString(), type: "credit_bounty", amount, description });
}

export function isAlive(ledger: Ledger, agent: string): boolean {
  const entry = ledger[agent];
  return !!entry && entry.balance > 0;
}

export function aliveAgents(ledger: Ledger): string[] {
  return Object.entries(ledger)
    .filter(([_, b]) => b.balance > 0)
    .map(([name]) => name);
}

/**
 * Write each agent's balance.json from the ledger.
 */
export async function syncBalances(ledger: Ledger): Promise<void> {
  for (const [agent, data] of Object.entries(ledger)) {
    const path = `${AGENTS_DIR}/${agent}/sandbox/balance.json`;
    await Bun.write(path, JSON.stringify(data, null, 2));
  }
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * Extract token usage from pi's --mode json JSONL output.
 * Pi emits turn_end events with per-turn usage, and an agent_end summary.
 * We sum all assistant message usage across turns.
 */
export function extractUsage(piJsonOutput: string): AgentUsage {
  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  for (const line of piJsonOutput.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      // turn_end events contain per-turn usage in message.usage
      if (event.type === "turn_end" && event.message?.usage) {
        const u = event.message.usage;
        usage.inputTokens += u.input ?? 0;
        usage.outputTokens += u.output ?? 0;
        usage.cacheReadTokens += u.cacheRead ?? 0;
        usage.totalTokens += u.totalTokens ?? 0;
        usage.costUsd += u.cost?.total ?? 0;
      }
    } catch {
      // Not a JSON line, skip
    }
  }
  return usage;
}

/**
 * Append a single wakeup-event to agent's memory/history.md.
 * Captures: when, what they did this wakeup (bids/submissions), token cost.
 * Aggregate events (auctions won, reviews received) are appended when they happen.
 */
export async function recordWakeup(
  agent: string,
  at: Date,
  usage: AgentUsage,
  context: {
    bidsPlaced: { task_id: string; price: number; description: string }[];
    reviewsCalled: { task_id: string; seq: number }[];
  }
): Promise<void> {
  const path = `${HISTORY_DIR}/${agent}.md`;
  const lines: string[] = [];

  const timestamp = at.toISOString().replace("T", " ").slice(0, 19);
  lines.push(`### ${timestamp} — wakeup`);
  lines.push(`Wakeup cost: ${usage.totalTokens.toLocaleString()} tokens deducted from balance (in ${usage.inputTokens.toLocaleString()}, out ${usage.outputTokens.toLocaleString()}, cache ${usage.cacheReadTokens.toLocaleString()}) — $${usage.costUsd.toFixed(4)}`);
  for (const b of context.bidsPlaced) {
    const desc = b.description.length > 80 ? b.description.slice(0, 80) + "…" : b.description;
    lines.push(`- bid **${b.price.toLocaleString()}** on ${b.task_id} (${desc})`);
  }
  for (const r of context.reviewsCalled) {
    lines.push(`- called review on ${r.task_id} #${r.seq}`);
  }
  lines.push("");

  await appendToFile(path, lines.join("\n"));
}

/**
 * Sum debits/credits for an agent within [fromTime, toTime].
 * Used to produce per-task cost summaries.
 */
export function summarizeWindow(
  ledger: Ledger,
  agent: string,
  fromTime: Date,
  toTime: Date
): { thinking: number; reviewFees: number; received: number; net: number } {
  const entry = ledger[agent];
  if (!entry) return { thinking: 0, reviewFees: 0, received: 0, net: 0 };
  let thinking = 0;
  let reviewFees = 0;
  let received = 0;
  for (const h of entry.history) {
    const t = new Date(h.at).getTime();
    if (t < fromTime.getTime() || t > toTime.getTime()) continue;
    if (h.type === "debit_thinking") thinking += h.amount;
    else if (h.type === "debit_review_fee") reviewFees += h.amount;
    else if (h.type === "credit_bounty") received += h.amount;
  }
  return { thinking, reviewFees, received, net: received - thinking - reviewFees };
}

export function summarizeTaskSettlement(
  ledger: Ledger,
  agent: string,
  taskId: string,
  fromTime: Date,
  toTime: Date
): { thinking: number; reviewFees: number; received: number; net: number } {
  const entry = ledger[agent];
  if (!entry) return { thinking: 0, reviewFees: 0, received: 0, net: 0 };
  let thinking = 0;
  let reviewFees = 0;
  let received = 0;
  for (const h of entry.history) {
    const t = new Date(h.at).getTime();
    if (h.type === "debit_thinking" && t >= fromTime.getTime() && t <= toTime.getTime()) {
      thinking += h.amount;
    }
    // Settlement amounts are task-addressed in ledger descriptions, so keep
    // them exact instead of relying on overlapping time windows.
    if (h.description.startsWith(`Review fee: ${taskId}`)) reviewFees += h.amount;
    if (h.description === `Accepted: ${taskId}`) received += h.amount;
  }
  return { thinking, reviewFees, received, net: received - thinking - reviewFees };
}

export function formatFinancialOutcome(net: number): string {
  if (net < 0) {
    return `Financial outcome: LOSS ${net} — BAD. This auction win reduced your balance; for similar tasks, bid above observed total cost plus margin or skip.`;
  }
  if (net > 0) {
    return `Financial outcome: WIN +${net} — good. This grew your balance; keep your bid floor at true total cost plus margin.`;
  }
  return "Financial outcome: BREAK-EVEN 0 — not good. You took risk for no profit; bid higher or skip similar tasks.";
}

export async function recordEvent(agent: string, at: Date, message: string): Promise<void> {
  const path = `${HISTORY_DIR}/${agent}.md`;
  const timestamp = at.toISOString().replace("T", " ").slice(0, 19);
  await appendToFile(path, `### ${timestamp} — ${message}\n\n`);
}

interface PendingSummary {
  task_id: string;
  agent: string;
  from_time: string;
  completed_at: string;
}

/**
 * Write a marker that a task's per-task cost summary should be flushed once
 * the agent's currently-in-flight wake has completed and its debit has
 * posted. Computing the summary at LGTM time is wrong: the wake that called
 * `request_review` is often still running, so its debit isn't in the ledger
 * yet and the summary undercounts cost.
 */
export async function writePendingSummary(p: PendingSummary): Promise<void> {
  await mkdir(PENDING_SUMMARIES_DIR, { recursive: true });
  await Bun.write(`${PENDING_SUMMARIES_DIR}/${p.task_id}.json`, JSON.stringify(p, null, 2));
}

/**
 * Flush any pending per-task summaries for `agent`. Caller must guarantee
 * no wake for `agent` is currently in flight (otherwise an unrelated wake's
 * debit could be attributed to the completed task). `toTime` is the upper
 * bound of the cost window — typically "now" at the moment of the call.
 */
async function taskBrief(taskId: string): Promise<string> {
  try {
    const task = await Bun.file(`${MARKET}/tasks/${taskId}.json`).json();
    const desc = String(task.description ?? "").replace(/\s+/g, " ").trim();
    return desc.length > 180 ? desc.slice(0, 180) + "…" : desc;
  } catch {
    return "(task details unavailable)";
  }
}

export async function flushPendingSummaries(
  ledger: Ledger,
  agent: string,
  toTime: Date
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(PENDING_SUMMARIES_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const path = `${PENDING_SUMMARIES_DIR}/${f}`;
    let p: PendingSummary;
    try {
      p = await Bun.file(path).json();
    } catch {
      continue;
    }
    if (p.agent !== agent) continue;
    const s = summarizeTaskSettlement(ledger, agent, p.task_id, new Date(p.from_time), toTime);
    const totalCost = s.thinking + s.reviewFees;
    const timestamp = toTime.toISOString().replace("T", " ").slice(0, 19);
    const lines = [
      `### ${timestamp} — completed task ${p.task_id}`,
      `Task: ${await taskBrief(p.task_id)}`,
      `Payment: ${s.received}`,
      `Cost: ${totalCost} (thinking ${s.thinking}, review fees ${s.reviewFees})`,
      `Net: ${s.net}`,
      formatFinancialOutcome(s.net),
      "",
    ];
    await appendToFile(`${HISTORY_DIR}/${agent}.md`, lines.join("\n"));
    await unlink(path).catch(() => {});
  }
}

async function appendToFile(path: string, content: string): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) await mkdir(path.slice(0, slash), { recursive: true });
  const existing = await Bun.file(path).text().catch(() => "");
  await Bun.write(path, existing + content);
}

// Run standalone: show current ledger state
if (import.meta.main) {
  const ledger = await loadLedger();
  for (const [agent, data] of Object.entries(ledger)) {
    const status = data.balance > 0 ? "alive" : "DEAD";
    console.log(`  ${agent}: ${data.balance} tokens [${status}]`);
  }
}
