/**
 * Ledger — balance management for all agents.
 *
 * Single source of truth. Agents only see their own balance.json.
 * The orchestrator reads/writes the full ledger.
 */

import { LedgerSchema, BalanceSchema, type Ledger, type Balance } from "./schemas";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "./agents";
const LEDGER_PATH = process.env.LEDGER_PATH ?? "./orchestrator/ledger.json";

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
    const path = `${AGENTS_DIR}/${agent}/balance.json`;
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
  const path = `${AGENTS_DIR}/${agent}/memory/history.md`;
  const lines: string[] = [];

  const timestamp = at.toISOString().replace("T", " ").slice(0, 19);
  lines.push(`### ${timestamp} — wakeup`);
  lines.push(`Tokens: ${usage.totalTokens.toLocaleString()} (in ${usage.inputTokens.toLocaleString()}, out ${usage.outputTokens.toLocaleString()}, cache ${usage.cacheReadTokens.toLocaleString()}) — $${usage.costUsd.toFixed(4)}`);
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

export async function recordEvent(agent: string, at: Date, message: string): Promise<void> {
  const path = `${AGENTS_DIR}/${agent}/memory/history.md`;
  const timestamp = at.toISOString().replace("T", " ").slice(0, 19);
  await appendToFile(path, `### ${timestamp} — ${message}\n\n`);
}

async function appendToFile(path: string, content: string): Promise<void> {
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
