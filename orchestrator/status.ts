import { readdir } from "node:fs/promises";
import {
  AssignmentSchema,
  BalanceSchema,
  BidSchema,
  LedgerSchema,
  ReviewRequestSchema,
  ReviewResponseSchema,
  TaskSchema,
  type ReviewResponse,
  type Task,
} from "./schemas";
import { bold, dim, green, red, yellow } from "./log";

const ROOT = process.cwd();
const MARKET = process.env.MARKET_DIR ?? `${ROOT}/market`;
const AGENTS_DIR = process.env.AGENTS_DIR ?? `${ROOT}/agents`;
const LEDGER_PATH = process.env.LEDGER_PATH ?? `${ROOT}/orchestrator/ledger.json`;
const PENDING_SUMMARIES_DIR = `${MARKET}/pending_summaries`;

type Schema<T> = { parse: (d: unknown) => T };
type TaskStatus = Task["status"];

interface Summary {
  agents: { name: string; balance: number | null; status: "alive" | "bankrupt" | "unknown" }[];
  tasks: Record<TaskStatus, number>;
  open_auctions: {
    id: string;
    deadline_at: string;
    bid_count: number;
    lowest_bid: number | null;
    description: string;
  }[];
  assigned: {
    task_id: string;
    winner: string | null;
    payment: number | null;
    reviews: number;
    pending_reviews: number;
    latest_verdict: string | null;
    description: string;
  }[];
  review_queue: { task_id: string; agent: string; seq: number; requested_at: string }[];
  warnings: string[];
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readParsed<T>(path: string, schema: Schema<T>, warnings: string[]): Promise<T | null> {
  try {
    return schema.parse(await Bun.file(path).json());
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    warnings.push(`invalid ${path}: ${msg}`);
    return null;
  }
}

async function readCollection<T>(dir: string, schema: Schema<T>, warnings: string[]): Promise<T[]> {
  const out: T[] = [];
  for (const f of await listJson(dir)) {
    const value = await readParsed(`${dir}/${f}`, schema, warnings);
    if (value) out.push(value);
  }
  return out;
}

async function readLedger(warnings: string[]): Promise<Record<string, { balance: number }> | null> {
  try {
    return LedgerSchema.parse(await Bun.file(LEDGER_PATH).json());
  } catch (e) {
    if (await Bun.file(LEDGER_PATH).exists()) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      warnings.push(`invalid ${LEDGER_PATH}: ${msg}`);
    }
    return null;
  }
}

function relTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const unit = diff < 0 ? "ago" : "";
  const prefix = diff < 0 ? "" : "in ";
  let value: string;
  if (abs < 60_000) value = `${Math.max(1, Math.round(abs / 1000))}s`;
  else if (abs < 3_600_000) value = `${Math.round(abs / 60_000)}m`;
  else if (abs < 86_400_000) value = `${Math.round(abs / 3_600_000)}h`;
  else value = `${Math.round(abs / 86_400_000)}d`;
  return `${prefix}${value}${unit ? ` ${unit}` : ""}`;
}

function latestResponse(responses: ReviewResponse[]): ReviewResponse | null {
  if (!responses.length) return null;
  return responses.reduce((best, r) => (r.seq > best.seq ? r : best), responses[0]);
}

function responseKey(r: { task_id: string; agent: string; seq: number }): string {
  return `${r.task_id}\0${r.agent}\0${r.seq}`;
}

async function buildSummary(): Promise<Summary> {
  const warnings: string[] = [];
  const [tasks, bids, assignments, reviewRequests, reviewResponses, ledger, agentNames] = await Promise.all([
    readCollection(`${MARKET}/tasks`, TaskSchema, warnings),
    readCollection(`${MARKET}/bids`, BidSchema, warnings),
    readCollection(`${MARKET}/assignments`, AssignmentSchema, warnings),
    readCollection(`${MARKET}/review_requests`, ReviewRequestSchema, warnings),
    readCollection(`${MARKET}/review_responses`, ReviewResponseSchema, warnings),
    readLedger(warnings),
    listDirs(AGENTS_DIR),
  ]);

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const assignmentByTask = new Map(assignments.map((a) => [a.task_id, a]));
  const responsesByKey = new Set(reviewResponses.map(responseKey));

  const taskCounts: Record<TaskStatus, number> = { open: 0, assigned: 0, completed: 0, expired: 0 };
  for (const t of tasks) taskCounts[t.status]++;

  for (const b of bids) {
    if (!taskById.has(b.task_id)) {
      warnings.push(`bid ${b.task_id}-${b.agent}.json targets missing task ${b.task_id}`);
    }
  }

  for (const a of assignments) {
    const t = taskById.get(a.task_id);
    if (!t) warnings.push(`assignment ${a.task_id}.json targets missing task ${a.task_id}`);
    else if (t.status !== "assigned" && t.status !== "completed") {
      warnings.push(`assignment ${a.task_id}.json targets ${t.status} task ${a.task_id}`);
    }
  }

  for (const t of tasks) {
    if (t.status === "assigned" && !assignmentByTask.has(t.id)) {
      warnings.push(`task ${t.id} is assigned but has no assignment file`);
    }
  }

  for (const r of reviewRequests) {
    if (!taskById.has(r.task_id)) warnings.push(`review request ${r.task_id}-${r.agent}-${r.seq}.json targets missing task`);
    if (!assignmentByTask.has(r.task_id)) warnings.push(`review request ${r.task_id}-${r.agent}-${r.seq}.json has no assignment`);
  }

  let pendingSummaries = 0;
  try { pendingSummaries = (await listJson(PENDING_SUMMARIES_DIR)).length; } catch {}
  if (pendingSummaries > 0) warnings.push(`${pendingSummaries} pending task cost summar${pendingSummaries === 1 ? "y" : "ies"}`);

  const agents: Summary["agents"] = [];
  const allAgentNames = new Set([...agentNames, ...Object.keys(ledger ?? {})]);
  for (const name of [...allAgentNames].sort()) {
    let balance = ledger?.[name]?.balance ?? null;
    const balancePath = `${AGENTS_DIR}/${name}/sandbox/balance.json`;
    const hasBalance = await Bun.file(balancePath).exists();
    if (!hasBalance) {
      warnings.push(`agent ${name} missing sandbox/balance.json`);
    } else if (balance === null) {
      const parsed = await readParsed(balancePath, BalanceSchema, warnings);
      if (parsed) balance = parsed.balance;
    }
    agents.push({
      name,
      balance,
      status: balance === null ? "unknown" : balance > 0 ? "alive" : "bankrupt",
    });
  }

  const open_auctions = tasks
    .filter((t) => t.status === "open")
    .sort((a, b) => new Date(a.deadline_at).getTime() - new Date(b.deadline_at).getTime())
    .map((t) => {
      const taskBids = bids.filter((b) => b.task_id === t.id);
      const prices = taskBids.map((b) => b.price).sort((a, b) => a - b);
      return {
        id: t.id,
        deadline_at: t.deadline_at,
        bid_count: taskBids.length,
        lowest_bid: prices[0] ?? null,
        description: t.description,
      };
    });

  const assigned = tasks
    .filter((t) => t.status === "assigned")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => {
      const a = assignmentByTask.get(t.id) ?? null;
      const relevantRequests = reviewRequests.filter((r) => r.task_id === t.id && (!a || r.agent === a.winner));
      const relevantResponses = reviewResponses.filter((r) => r.task_id === t.id && (!a || r.agent === a.winner));
      const pending = relevantRequests.filter((r) => !responsesByKey.has(responseKey(r)));
      return {
        task_id: t.id,
        winner: a?.winner ?? null,
        payment: a?.payment ?? null,
        reviews: relevantRequests.length,
        pending_reviews: pending.length,
        latest_verdict: latestResponse(relevantResponses)?.verdict ?? null,
        description: t.description,
      };
    });

  const review_queue = reviewRequests
    .filter((r) => !responsesByKey.has(responseKey(r)))
    .sort((a, b) => new Date(a.requested_at).getTime() - new Date(b.requested_at).getTime())
    .map((r) => ({ task_id: r.task_id, agent: r.agent, seq: r.seq, requested_at: r.requested_at }));

  warnings.sort();
  return { agents, tasks: taskCounts, open_auctions, assigned, review_queue, warnings };
}

function money(n: number | null): string {
  return n === null ? "?" : n.toLocaleString();
}

function truncate(s: string, max = 96): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function printText(s: Summary): void {
  console.log(bold("Agents"));
  if (!s.agents.length) console.log(dim("  none"));
  for (const a of s.agents) {
    const color = a.status === "alive" ? green : a.status === "bankrupt" ? red : yellow;
    console.log(`  ${a.name.padEnd(12)} ${money(a.balance).padStart(12)} ${color(a.status)}`);
  }

  console.log();
  console.log(bold("Tasks"));
  console.log(`  open: ${s.tasks.open}, assigned: ${s.tasks.assigned}, completed: ${s.tasks.completed}, expired: ${s.tasks.expired}`);

  console.log();
  console.log(bold("Open auctions"));
  if (!s.open_auctions.length) console.log(dim("  none"));
  for (const t of s.open_auctions) {
    const low = t.lowest_bid === null ? "none" : t.lowest_bid.toLocaleString();
    console.log(`  ${t.id.padEnd(12)} ${relTime(t.deadline_at).padEnd(10)} bids=${String(t.bid_count).padEnd(2)} low=${low.padEnd(10)} ${truncate(t.description)}`);
  }

  console.log();
  console.log(bold("Assigned"));
  if (!s.assigned.length) console.log(dim("  none"));
  for (const a of s.assigned) {
    const verdict = a.latest_verdict ?? "no_review";
    const pending = a.pending_reviews ? ` pending=${a.pending_reviews}` : "";
    console.log(`  ${a.task_id.padEnd(12)} -> ${(a.winner ?? "?").padEnd(12)} payment=${money(a.payment).padEnd(10)} reviews=${a.reviews}${pending} latest=${verdict}  ${truncate(a.description)}`);
  }

  console.log();
  console.log(bold("Review queue"));
  if (!s.review_queue.length) console.log(dim("  none"));
  for (const r of s.review_queue) {
    console.log(`  ${r.task_id} ${r.agent} #${r.seq} requested ${relTime(r.requested_at)}`);
  }

  console.log();
  console.log(bold("Warnings"));
  if (!s.warnings.length) console.log(dim("  none"));
  for (const w of s.warnings) console.log(yellow(`  ! ${w}`));
}

async function main(): Promise<void> {
  const summary = await buildSummary();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printText(summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
