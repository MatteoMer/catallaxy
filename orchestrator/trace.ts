import { readdir, readFile } from "node:fs/promises";
import {
  AssignmentSchema,
  BidSchema,
  LedgerSchema,
  ReviewRequestSchema,
  ReviewResponseSchema,
  TaskSchema,
  type Bid,
  type ReviewRequest,
  type ReviewResponse,
  type Task,
} from "./schemas";
import { bold, dim, green, red, yellow } from "./log";

const ROOT = process.cwd();
const MARKET = process.env.MARKET_DIR ?? `${ROOT}/market`;
const LEDGER_PATH = process.env.LEDGER_PATH ?? `${ROOT}/orchestrator/ledger.json`;
const RESERVATIONS_PATH = process.env.RESERVATIONS_PATH ?? `${ROOT}/orchestrator/private/reservations.json`;
const HISTORY_DIR = process.env.AGENT_HISTORY_DIR ?? `${ROOT}/orchestrator/private/history`;

type Schema<T> = { parse: (d: unknown) => T };

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function readParsed<T>(path: string, schema: Schema<T>, warnings: string[] = []): Promise<T | null> {
  try {
    return schema.parse(await Bun.file(path).json());
  } catch (e) {
    if (await Bun.file(path).exists()) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      warnings.push(`invalid ${path}: ${msg}`);
    }
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

async function loadReservations(): Promise<Record<string, number>> {
  try {
    const raw = await Bun.file(RESERVATIONS_PATH).json();
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function fmtShort(iso: string | null | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

function relTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  let value: string;
  if (abs < 60_000) value = `${Math.max(1, Math.round(abs / 1000))}s`;
  else if (abs < 3_600_000) value = `${Math.round(abs / 60_000)}m`;
  else if (abs < 86_400_000) value = `${Math.round(abs / 3_600_000)}h`;
  else value = `${Math.round(abs / 86_400_000)}d`;
  return diff < 0 ? `${value} ago` : `in ${value}`;
}

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "?" : n.toLocaleString();
}

function truncate(s: string, max = 110): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function latestResponse(responses: ReviewResponse[]): ReviewResponse | null {
  if (!responses.length) return null;
  return responses.reduce((best, r) => (r.seq > best.seq ? r : best), responses[0]);
}

function responseKey(r: { task_id: string; agent: string; seq: number }): string {
  return `${r.task_id}\0${r.agent}\0${r.seq}`;
}

async function historyRefs(agent: string, taskId: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(`${HISTORY_DIR}/${agent}.md`, "utf-8");
  } catch {
    return [];
  }

  const refs: string[] = [];
  const blocks = text.split(/(?=^### )/m);
  for (const block of blocks) {
    if (!block.includes(taskId)) continue;
    const lines = block.trim().split("\n").filter(Boolean);
    if (!lines.length) continue;
    refs.push(lines.map((line, i) => (i === 0 ? line.replace(/^### /, "") : `  ${line}`)).join("\n"));
  }
  return refs;
}

function ledgerWindow(
  ledger: any,
  agent: string,
  fromIso: string,
  toIso: string
): { thinking: number; reviewFees: number; received: number; net: number } {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  const rows = ledger?.[agent]?.history ?? [];
  let thinking = 0;
  let reviewFees = 0;
  let received = 0;
  for (const h of rows) {
    const t = new Date(h.at).getTime();
    if (t < from || t > to) continue;
    if (h.type === "debit_review_fee" || h.description?.startsWith("Review fee:")) reviewFees += h.amount;
    else if (h.type === "debit_thinking") thinking += h.amount;
    else if (h.type === "credit_bounty") received += h.amount;
  }
  return { thinking, reviewFees, received, net: received - thinking - reviewFees };
}

function taskLedgerEntries(ledger: any, taskId: string): { agent: string; at: string; type: string; amount: number; description: string }[] {
  const out: { agent: string; at: string; type: string; amount: number; description: string }[] = [];
  for (const [agent, data] of Object.entries<any>(ledger ?? {})) {
    for (const h of data.history ?? []) {
      if (typeof h.description === "string" && h.description.includes(taskId)) {
        out.push({ agent, at: h.at, type: h.type, amount: h.amount, description: h.description });
      }
    }
  }
  out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return out;
}

interface TraceData {
  task: Task;
  reservation: number | null;
  bids: Bid[];
  assignment: any | null;
  requests: ReviewRequest[];
  responses: ReviewResponse[];
  pendingRequests: ReviewRequest[];
  ledgerEntries: ReturnType<typeof taskLedgerEntries>;
  window: { thinking: number; reviewFees: number; received: number; net: number } | null;
  refs: string[];
  warnings: string[];
}

async function buildTrace(taskId: string): Promise<TraceData | null> {
  const warnings: string[] = [];
  const task = await readParsed(`${MARKET}/tasks/${taskId}.json`, TaskSchema, warnings);
  if (!task) return null;

  const [allBids, allRequests, allResponses, ledger, reservations] = await Promise.all([
    readCollection(`${MARKET}/bids`, BidSchema, warnings),
    readCollection(`${MARKET}/review_requests`, ReviewRequestSchema, warnings),
    readCollection(`${MARKET}/review_responses`, ReviewResponseSchema, warnings),
    readParsed(LEDGER_PATH, LedgerSchema, warnings),
    loadReservations(),
  ]);

  const assignment = await readParsed(`${MARKET}/assignments/${taskId}.json`, AssignmentSchema, warnings);
  const bids = allBids.filter((b) => b.task_id === taskId).sort((a, b) => a.price - b.price || a.agent.localeCompare(b.agent));
  const requests = allRequests.filter((r) => r.task_id === taskId).sort((a, b) => a.seq - b.seq || a.agent.localeCompare(b.agent));
  const responses = allResponses.filter((r) => r.task_id === taskId).sort((a, b) => a.seq - b.seq || a.agent.localeCompare(b.agent));
  const responseKeys = new Set(responses.map(responseKey));
  const pendingRequests = requests.filter((r) => !responseKeys.has(responseKey(r)));

  let window = null;
  let refs: string[] = [];
  if (assignment && ledger) {
    const latest = latestResponse(responses);
    const to = task.status === "completed" && latest ? latest.reviewed_at : new Date().toISOString();
    window = ledgerWindow(ledger, assignment.winner, task.posted_at, to);
    refs = await historyRefs(assignment.winner, taskId);
  }

  return {
    task,
    reservation: reservations[taskId] ?? null,
    bids,
    assignment,
    requests,
    responses,
    pendingRequests,
    ledgerEntries: ledger ? taskLedgerEntries(ledger, taskId) : [],
    window,
    refs,
    warnings,
  };
}

function printTrace(t: TraceData): void {
  const statusColor = t.task.status === "completed" ? green : t.task.status === "expired" ? red : t.task.status === "assigned" ? yellow : dim;
  console.log(`${bold(t.task.id)} — ${statusColor(t.task.status)} — ${truncate(t.task.description, 140)}`);
  console.log();

  console.log(bold("task"));
  console.log(`  posted      ${fmtTime(t.task.posted_at)} by ${t.task.posted_by}`);
  console.log(`  deadline    ${fmtTime(t.task.deadline_at)} (${relTime(t.task.deadline_at)})`);
  console.log(`  repo        ${t.task.repo} @ ${t.task.base_branch}`);
  console.log(`  review_fee  ${money(t.task.review_fee)}`);
  console.log(`  reservation ${t.reservation === null ? "missing" : money(t.reservation)}`);
  if (t.task.deterministic_checks.length) {
    console.log(`  checks`);
    for (const c of t.task.deterministic_checks) {
      if (c.type === "command") console.log(`    command ${c.must_pass ? "must pass" : "optional"}: ${c.cmd}`);
      else console.log(`    files untouched: ${c.paths.join(", ")}`);
    }
  }
  if (t.task.subjective_criteria) console.log(`  subjective  ${t.task.subjective_criteria}`);

  console.log();
  console.log(bold("bids"));
  if (!t.bids.length) console.log(dim("  none"));
  for (const b of t.bids) {
    const marker = t.assignment?.winner === b.agent ? green(" winner") : "";
    console.log(`  ${b.agent.padEnd(12)} ${money(b.price).padStart(10)}  ${fmtShort(b.created_at)}${marker}`);
  }

  console.log();
  console.log(bold("assignment"));
  if (!t.assignment) console.log(dim("  none"));
  else {
    console.log(`  winner      ${t.assignment.winner}`);
    console.log(`  payment     ${money(t.assignment.payment)}`);
    console.log(`  assigned_at ${fmtTime(t.assignment.assigned_at)}`);
  }

  console.log();
  console.log(bold("reviews"));
  if (!t.requests.length && !t.responses.length) console.log(dim("  none"));
  for (const req of t.requests) {
    const resp = t.responses.find((r) => responseKey(r) === responseKey(req));
    const verdict = resp ? (resp.verdict === "lgtm" ? green(resp.verdict) : red(resp.verdict)) : yellow("pending");
    console.log(`  #${req.seq} ${req.agent} branch=${req.branch} requested=${fmtShort(req.requested_at)} verdict=${verdict}`);
    if (resp) {
      console.log(`     reviewed=${fmtShort(resp.reviewed_at)}`);
      for (const line of resp.feedback.trim().split("\n")) console.log(`     ${line}`);
    }
  }
  for (const resp of t.responses) {
    if (t.requests.some((r) => responseKey(r) === responseKey(resp))) continue;
    const verdict = resp.verdict === "lgtm" ? green(resp.verdict) : red(resp.verdict);
    console.log(`  #${resp.seq} ${resp.agent} response-without-request verdict=${verdict} reviewed=${fmtShort(resp.reviewed_at)}`);
  }

  console.log();
  console.log(bold("ledger impact"));
  if (!t.ledgerEntries.length && !t.window) console.log(dim("  none"));
  for (const e of t.ledgerEntries) {
    const sign = e.type.startsWith("credit") ? "+" : "-";
    console.log(`  ${fmtShort(e.at)} ${e.agent.padEnd(12)} ${sign}${money(e.amount).padStart(10)}  ${e.description}`);
  }
  if (t.window) {
    console.log(`  window total thinking=${money(t.window.thinking)} review_fees=${money(t.window.reviewFees)} received=${money(t.window.received)} net=${money(t.window.net)}`);
  }

  console.log();
  console.log(bold("agent history refs"));
  if (!t.refs.length) console.log(dim("  none"));
  for (const ref of t.refs) {
    for (const line of ref.split("\n")) console.log(`  ${line}`);
  }

  console.log();
  console.log(bold("warnings"));
  if (!t.warnings.length) console.log(dim("  none"));
  for (const w of t.warnings) console.log(yellow(`  ! ${w}`));
}

function printHelp(): void {
  console.log(`Usage: bun orchestrator/trace.ts TASK_ID [--json]

Examples:
  bun orchestrator/trace.ts task-010
  bun orchestrator/trace.ts task-010 --json
  make trace TASK=task-010`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--json");
  if (process.argv.includes("-h") || process.argv.includes("--help") || args.length !== 1) {
    printHelp();
    process.exit(args.length === 1 ? 0 : 1);
  }

  const trace = await buildTrace(args[0]);
  if (!trace) {
    console.error(`task not found: ${args[0]}`);
    process.exit(1);
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(trace, null, 2));
  else printTrace(trace);
}

if (import.meta.main) await main();
