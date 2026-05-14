/**
 * Ledger — balance management for all agents.
 *
 * Single source of truth. Agents only see their own balance.json.
 * The orchestrator reads/writes the full ledger.
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { LedgerSchema, BalanceSchema, type Ledger, type Balance } from "./schemas";
export type { Ledger } from "./schemas";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "./agents";
const LEDGER_PATH = process.env.LEDGER_PATH ?? "./orchestrator/ledger.json";
const MARKET = process.env.MARKET_DIR ?? "./market";
const PENDING_SUMMARIES_DIR = `${MARKET}/pending_summaries`;
// History lives outside the agent's sandbox so the agent's pi process
// has no filesystem path to write it. Agents read history via the
// `history` tool exposed by extensions/catallaxy.ts.
const HISTORY_DIR = process.env.AGENT_HISTORY_DIR ?? "./orchestrator/private/history";

export const DEFAULT_STARTING_BALANCE = 15_000_000;

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

export function initAgent(ledger: Ledger, name: string, startingBalance = DEFAULT_STARTING_BALANCE): void {
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

export function debitEscrowLock(
  ledger: Ledger,
  agent: string,
  amount: number,
  description: string,
  at: Date = new Date()
): void {
  const entry = ledger[agent];
  if (!entry) return;
  entry.balance -= amount;
  entry.history.push({ at: at.toISOString(), type: "debit_escrow_lock", amount, description });
}

export function creditEscrowRefund(
  ledger: Ledger,
  agent: string,
  amount: number,
  description: string,
  at: Date = new Date()
): void {
  const entry = ledger[agent];
  if (!entry) return;
  entry.balance += amount;
  entry.history.push({ at: at.toISOString(), type: "credit_escrow_refund", amount, description });
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
  /** Fresh input tokens reported by pi/provider. */
  inputTokens: number;
  /** Output tokens reported by pi/provider. */
  outputTokens: number;
  /** Cache-read tokens reported by pi/provider. */
  cacheReadTokens: number;
  /** Cache-write tokens reported by pi/provider. */
  cacheWriteTokens: number;
  /** Raw provider total tokens, for telemetry/context sizing only. */
  totalTokens: number;
  /** Balance debit units after model-specific token accounting ratios. */
  billableTokens: number;
  costUsd: number;
}

export interface TokenAccountingRatios {
  /** Fresh input token multiplier. Usually 1. */
  input: number;
  /** Output token multiplier, relative to input tokens for this model. */
  output: number;
  /** Cache-read token multiplier, relative to input tokens for this model. */
  cacheRead: number;
  /** Cache-write token multiplier, relative to input tokens for this model. */
  cacheWrite: number;
}

const DEFAULT_TOKEN_RATIOS: TokenAccountingRatios = {
  input: 1,
  output: 1,
  cacheRead: 0.1,
  cacheWrite: 1,
};

function cleanModelId(model: string | undefined | null): string | null {
  const m = model?.trim();
  return m ? m : null;
}

function parseRatioNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeRatios(raw: unknown): Partial<TokenAccountingRatios> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<TokenAccountingRatios> = {};
  const input = parseRatioNumber(r.input);
  const output = parseRatioNumber(r.output);
  const cacheRead = parseRatioNumber(r.cacheRead ?? r.cache_read);
  const cacheWrite = parseRatioNumber(r.cacheWrite ?? r.cache_write);
  if (input !== null) out.input = input;
  if (output !== null) out.output = output;
  if (cacheRead !== null) out.cacheRead = cacheRead;
  if (cacheWrite !== null) out.cacheWrite = cacheWrite;
  return Object.keys(out).length ? out : null;
}

function modelAliases(model: string): string[] {
  const aliases = [model];
  const firstSlash = model.indexOf("/");
  if (firstSlash >= 0 && firstSlash + 1 < model.length) aliases.push(model.slice(firstSlash + 1));
  return aliases;
}

function envModelRatios(): Record<string, Partial<TokenAccountingRatios>> {
  // JSON format:
  //   CATALLAXY_MODEL_TOKEN_RATIOS='{"openrouter/foo":{"output":4,"cacheRead":0.1}}'
  const raw = process.env.CATALLAXY_MODEL_TOKEN_RATIOS ?? process.env.CATALLAXY_TOKEN_RATIOS;
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, Partial<TokenAccountingRatios>> = {};
    for (const [model, ratios] of Object.entries(parsed)) {
      const normalized = normalizeRatios(ratios);
      if (normalized) out[model] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

export function tokenAccountingRatiosForModel(model?: string | null): TokenAccountingRatios {
  const ratios = { ...DEFAULT_TOKEN_RATIOS };
  const globalCacheRead = parseRatioNumber(process.env.CATALLAXY_CACHE_READ_RATIO);
  if (globalCacheRead !== null) ratios.cacheRead = globalCacheRead;
  const globalCacheWrite = parseRatioNumber(process.env.CATALLAXY_CACHE_WRITE_RATIO);
  if (globalCacheWrite !== null) ratios.cacheWrite = globalCacheWrite;

  const m = cleanModelId(model);
  if (m) {
    const byModel = envModelRatios();
    for (const alias of modelAliases(m)) {
      const override = byModel[alias];
      if (override) Object.assign(ratios, override);
    }
  }
  return ratios;
}

export function billableTokensForUsage(usage: Pick<AgentUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">, model?: string | null): number {
  const r = tokenAccountingRatiosForModel(model);
  return Math.ceil(
    usage.inputTokens * r.input +
    usage.outputTokens * r.output +
    usage.cacheReadTokens * r.cacheRead +
    usage.cacheWriteTokens * r.cacheWrite
  );
}

export function emptyUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    billableTokens: 0,
    costUsd: 0,
  };
}

export function addUsage(a: AgentUsage, b: AgentUsage): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheWriteTokens += b.cacheWriteTokens;
  a.totalTokens += b.totalTokens;
  a.billableTokens += b.billableTokens;
  a.costUsd += b.costUsd;
}

export function usageFromPiUsage(u: any, model?: string | null): AgentUsage {
  const inputTokens = Number(u?.input ?? 0);
  const outputTokens = Number(u?.output ?? 0);
  const cacheReadTokens = Number(u?.cacheRead ?? 0);
  const cacheWriteTokens = Number(u?.cacheWrite ?? 0);
  const rawTotal = Number(u?.totalTokens ?? (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens));
  const partial = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  return {
    ...partial,
    totalTokens: Number.isFinite(rawTotal) ? rawTotal : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    billableTokens: billableTokensForUsage(partial, model),
    costUsd: Number(u?.cost?.total ?? 0),
  };
}

/**
 * Extract token usage from pi's --mode json JSONL output.
 * Pi emits turn_end events with per-turn usage, and an agent_end summary.
 * We sum all assistant message usage across turns.
 */
export function extractUsage(piJsonOutput: string, model?: string | null): AgentUsage {
  const usage: AgentUsage = emptyUsage();

  for (const line of piJsonOutput.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      // turn_end events contain per-turn usage in message.usage
      if (event.type === "turn_end" && event.message?.usage) {
        const u = event.message.usage;
        addUsage(usage, usageFromPiUsage(u, model));
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
  lines.push(`Wakeup cost: ${usage.billableTokens.toLocaleString()} billable tokens deducted from balance (raw ${usage.totalTokens.toLocaleString()}; in ${usage.inputTokens.toLocaleString()}, out ${usage.outputTokens.toLocaleString()}, cache read ${usage.cacheReadTokens.toLocaleString()}, cache write ${usage.cacheWriteTokens.toLocaleString()}) — $${usage.costUsd.toFixed(4)}`);
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
