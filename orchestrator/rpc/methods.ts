/**
 * RPC method handlers — one function per catallaxy tool.
 *
 * Handlers take (agent, params) and return a plain result. They mirror
 * the shape of what extensions/catallaxy.ts used to compute locally
 * by reading market/ files; the extension (now an RPC client) gets
 * back enough structure to format its tool reply.
 *
 * The agent identity is implicit (which socket the request arrived on)
 * — handlers MUST trust the agent argument given to them and ignore
 * any agent name in params.
 */

import { appendFile, lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { logEvent } from "../events";
import {
  TaskSchema, BidSchema, AssignmentSchema,
  ReviewRequestSchema, ReviewResponseSchema, BalanceSchema,
  type Ledger,
} from "../schemas";
import { debitEscrowLock, recordEvent } from "../ledger";
import { createEscrow, getEscrow, refundEscrow } from "../escrow";
import { workDirFor } from "../workdir";

const ROOT = process.cwd();
const MARKET = process.env.MARKET_DIR ?? `${ROOT}/market`;
const AGENTS_DIR = process.env.AGENTS_DIR ?? `${ROOT}/agents`;
const HISTORY_DIR = process.env.AGENT_HISTORY_DIR ?? `${ROOT}/orchestrator/private/history`;
const RESERVATIONS_PATH = process.env.RESERVATIONS_PATH ?? `${ROOT}/orchestrator/private/reservations.json`;

interface LedgerAccess {
  ledger: Ledger;
  persist: () => Promise<void>;
}

let ledgerAccess: LedgerAccess | null = null;

export function setLedgerAccess(ledger: Ledger, persist: () => Promise<void>): void {
  ledgerAccess = { ledger, persist };
}

function requireLedgerAccess(): LedgerAccess {
  if (!ledgerAccess) throw new Error("ledger unavailable; create_task/cancel_created_task disabled");
  return ledgerAccess;
}

const MEMORY_KEY_MAX_CHARS = Math.max(16, parseInt(process.env.CATALLAXY_MEMORY_KEY_MAX_CHARS ?? "160", 10) || 160);
const MEMORY_READ_MAX_BYTES = Math.max(256, parseInt(process.env.CATALLAXY_MEMORY_READ_MAX_BYTES ?? "32768", 10) || 32768);
const MEMORY_WRITE_MAX_BYTES = Math.max(256, parseInt(process.env.CATALLAXY_MEMORY_WRITE_MAX_BYTES ?? "32768", 10) || 32768);
const MEMORY_FILE_MAX_BYTES = Math.max(MEMORY_WRITE_MAX_BYTES, parseInt(process.env.CATALLAXY_MEMORY_FILE_MAX_BYTES ?? "32768", 10) || 32768);
const MEMORY_TOTAL_MAX_BYTES = Math.max(MEMORY_FILE_MAX_BYTES, parseInt(process.env.CATALLAXY_MEMORY_TOTAL_MAX_BYTES ?? "262144", 10) || 262144);
const MEMORY_LIST_MAX_ITEMS = Math.max(1, parseInt(process.env.CATALLAXY_MEMORY_LIST_MAX_ITEMS ?? "200", 10) || 200);

export interface WakeScope {
  kind: "bid" | "work";
  taskId?: string;
}

const wakeScopes = new Map<string, WakeScope>();

export function setWakeScope(agent: string, scope: WakeScope): void {
  wakeScopes.set(agent, scope);
}

export function clearWakeScope(agent: string): void {
  wakeScopes.delete(agent);
}

function wakeScope(agent: string): WakeScope | undefined {
  return wakeScopes.get(agent);
}

function assertWorkTaskAllowed(agent: string, taskId: string, method: string): void {
  const scope = wakeScope(agent);
  if (!scope) return;
  if (scope.kind === "bid") throw new Error(`${method} is disabled during bid wakes`);
  if (scope.taskId && taskId !== scope.taskId) {
    throw new Error(`work wake is scoped to ${scope.taskId}; ${method} for ${taskId} is not allowed`);
  }
}

function assertTaskInfoAllowed(agent: string, taskId: string, taskStatus: string): void {
  const scope = wakeScope(agent);
  if (!scope) return;
  if (scope.kind === "work") {
    if (scope.taskId && taskId !== scope.taskId) {
      throw new Error(`work wake is scoped to ${scope.taskId}; task_info for ${taskId} is not allowed`);
    }
    return;
  }
  if (taskStatus !== "open") throw new Error(`bid wake can only inspect open auctions; ${taskId} is ${taskStatus}`);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function gitRefExists(workDir: string, ref: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "-C", workDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited === 0;
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

let createTaskLock: Promise<void> = Promise.resolve();

async function withCreateTaskLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = createTaskLock;
  let release!: () => void;
  createTaskLock = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try { return await fn(); }
  finally { release(); }
}

async function nextTaskId(): Promise<string> {
  let max = 0;
  for (const f of await listJson(`${MARKET}/tasks`)) {
    const m = f.match(/^task-(\d+)\.json$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `task-${String(max + 1).padStart(3, "0")}`;
}

async function loadReservations(): Promise<Record<string, number>> {
  try { return await readJson<Record<string, number>>(RESERVATIONS_PATH); }
  catch { return {}; }
}

async function saveReservations(reservations: Record<string, number>): Promise<void> {
  await writeJson(RESERVATIONS_PATH, reservations);
}

function taskCreator(task: { creator?: string; posted_by?: string }): string | null {
  if (task.creator) return task.creator;
  const postedBy = task.posted_by ?? "";
  return postedBy.startsWith("agent:") ? postedBy.slice("agent:".length) : null;
}

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function gitOutput(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

async function gitCurrentBranch(repo: string): Promise<string | null> {
  try {
    const branch = await gitOutput(["git", "-C", repo, "branch", "--show-current"]);
    return branch || null;
  } catch {
    return null;
  }
}

type MemoryItem = { key: string; path: string; bytes: number; updated_at: string };

type MemoryWriteMode = "replace" | "append";

function memoryRoot(agent: string): string {
  return join(AGENTS_DIR, agent, "sandbox", "memory");
}

function validateMemoryKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("key required");
  const key = value.trim();
  if (!key) throw new Error("key required");
  if (key.length > MEMORY_KEY_MAX_CHARS) throw new Error(`key too long; max ${MEMORY_KEY_MAX_CHARS} chars`);
  if (key.startsWith("/") || key.includes("\\")) throw new Error("invalid memory key");
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) throw new Error("invalid memory key; use letters, digits, '.', '_', '-', '/' only");
  const parts = key.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) throw new Error("invalid memory key path");
  return key;
}

function parseMemoryMode(value: unknown): MemoryWriteMode {
  if (value === undefined || value === null || value === "replace") return "replace";
  if (value === "append") return "append";
  throw new Error("mode must be 'replace' or 'append'");
}

async function ensureMemoryRoot(agent: string): Promise<string> {
  const root = memoryRoot(agent);
  await mkdir(root, { recursive: true });
  const st = await lstat(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("invalid memory root");
  return root;
}

async function assertSafeMemoryAncestors(root: string, key: string): Promise<void> {
  let cur = root;
  for (const part of key.split("/").slice(0, -1)) {
    cur = join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (e: any) {
      if (e?.code === "ENOENT") break;
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error("memory path contains a symlink");
    if (!st.isDirectory()) throw new Error("memory path parent is not a directory");
  }
}

async function memoryFile(agent: string, rawKey: unknown): Promise<{ root: string; key: string; path: string }> {
  const root = await ensureMemoryRoot(agent);
  const key = validateMemoryKey(rawKey);
  const path = join(root, key);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..")) throw new Error("invalid memory key path");
  await assertSafeMemoryAncestors(root, key);
  return { root, key, path };
}

async function checkedMemoryFileStat(path: string): Promise<{ size: number } | null> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Error("memory file is a symlink");
    if (!st.isFile()) throw new Error("memory key is not a file");
    return { size: st.size };
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

async function listMemoryItemsForRoot(root: string, dir = root, prefix = ""): Promise<MemoryItem[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: MemoryItem[] = [];
  for (const ent of entries) {
    const key = prefix ? `${prefix}/${ent.name}` : ent.name;
    // Only expose keys that the memory_read/write APIs can address.
    try { validateMemoryKey(key); } catch { continue; }

    const path = join(dir, ent.name);
    let st;
    try { st = await lstat(path); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.push(...await listMemoryItemsForRoot(root, path, key));
    } else if (st.isFile()) {
      out.push({ key, path, bytes: st.size, updated_at: st.mtime.toISOString() });
    }
  }
  return out;
}

async function listMemoryItems(agent: string): Promise<MemoryItem[]> {
  const root = await ensureMemoryRoot(agent);
  const items = await listMemoryItemsForRoot(root);
  items.sort((a, b) => a.key.localeCompare(b.key));
  return items;
}

async function totalMemoryBytes(agent: string): Promise<number> {
  return (await listMemoryItems(agent)).reduce((sum, item) => sum + item.bytes, 0);
}

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export async function list_tasks(agent: string, _params: unknown): Promise<{ tasks: any[] }> {
  const scope = wakeScope(agent);
  if (scope?.kind === "work") throw new Error("list_tasks is disabled during work wakes");
  const out: any[] = [];
  for (const f of await listJson(`${MARKET}/tasks`)) {
    try {
      const t = TaskSchema.parse(await readJson(`${MARKET}/tasks/${f}`));
      if (t.status === "open" && taskCreator(t) !== agent) {
        out.push({
          id: t.id,
          deadline_at: t.deadline_at,
          review_fee: t.review_fee,
          description: t.description,
        });
      }
    } catch {}
  }
  return { tasks: out };
}

export async function task_info(agent: string, params: any): Promise<any> {
  const taskId = params?.task_id;
  if (typeof taskId !== "string") throw new Error("task_id required");
  let t: any;
  try {
    t = TaskSchema.parse(await readJson(`${MARKET}/tasks/${taskId}.json`));
  } catch {
    return { task: null };
  }
  assertTaskInfoAllowed(agent, taskId, t.status);
  return { task: t };
}

export async function my_assignments(agent: string, _params: unknown): Promise<{ assignments: any[] }> {
  const out: any[] = [];
  const scope = wakeScope(agent);
  for (const f of await listJson(`${MARKET}/assignments`)) {
    try {
      const a = AssignmentSchema.parse(await readJson(`${MARKET}/assignments/${f}`));
      if (a.winner !== agent) continue;
      if (scope?.kind === "work" && scope.taskId && a.task_id !== scope.taskId) continue;
      if (scope?.kind === "bid") continue;
      let task: any = null;
      try { task = TaskSchema.parse(await readJson(`${MARKET}/tasks/${a.task_id}.json`)); } catch {}
      out.push({
        task_id: a.task_id,
        payment: a.payment,
        assigned_at: a.assigned_at,
        task_status: task?.status ?? null,
        description: task?.description ?? null,
      });
    } catch {}
  }
  return { assignments: out };
}

export async function task_verdicts(agent: string, params: any): Promise<{ verdicts: any[] }> {
  const taskId = params?.task_id;
  if (typeof taskId !== "string") throw new Error("task_id required");
  assertWorkTaskAllowed(agent, taskId, "task_verdicts");
  const out: any[] = [];
  for (const f of await listJson(`${MARKET}/review_responses`)) {
    try {
      const r = ReviewResponseSchema.parse(await readJson(`${MARKET}/review_responses/${f}`));
      if (r.task_id === taskId && r.agent === agent) out.push(r);
    } catch {}
  }
  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return { verdicts: out };
}

function parseDeterministicChecks(raw: unknown): Array<{ type: "command"; cmd: string; must_pass: boolean }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("deterministic_checks must be an array");
  if (raw.length > 10) throw new Error("deterministic_checks max length is 10");
  return raw.map((c, i) => {
    if (typeof c === "string") {
      if (!c.trim()) throw new Error(`deterministic_checks[${i}] empty command`);
      return { type: "command" as const, cmd: c, must_pass: true };
    }
    if (c && typeof c === "object" && (c as any).type === "command" && typeof (c as any).cmd === "string") {
      if (!(c as any).cmd.trim()) throw new Error(`deterministic_checks[${i}] empty command`);
      return { type: "command" as const, cmd: (c as any).cmd, must_pass: (c as any).must_pass !== false };
    }
    throw new Error(`deterministic_checks[${i}] must be a command string or {type:'command', cmd}`);
  });
}

export async function create_task(agent: string, params: any): Promise<{ task: any; escrow: any; warnings: string[] }> {
  const { ledger, persist } = requireLedgerAccess();
  const balance = ledger[agent]?.balance ?? 0;
  if (balance <= 0) throw new Error("bankrupt agents cannot create tasks");

  const description = typeof params?.description === "string" ? params.description.trim() : "";
  if (!description) throw new Error("description required");
  if (description.length > 12_000) throw new Error("description too long; max 12000 chars");

  const reservation = positiveInt(params?.reservation ?? params?.max_payment, "reservation/max_payment");
  if (reservation > balance) throw new Error(`insufficient balance for escrow: need ${reservation}, have ${balance}`);

  const reviewFee = params?.review_fee === undefined ? 2_000 : positiveInt(params.review_fee, "review_fee");
  const deadlineMinutes = params?.deadline_minutes === undefined ? 5 : positiveInt(params.deadline_minutes, "deadline_minutes");
  if (deadlineMinutes > 24 * 60) throw new Error("deadline_minutes too large; max 1440");

  const scope = wakeScope(agent);
  const sourceTaskId = typeof params?.source_task_id === "string" && params.source_task_id.trim()
    ? params.source_task_id.trim()
    : scope?.kind === "work" ? scope.taskId : undefined;
  if (!sourceTaskId) throw new Error("source_task_id required unless creating from the current work wake assignment");
  if (scope?.kind === "work" && scope.taskId && sourceTaskId !== scope.taskId) {
    throw new Error(`work wake is scoped to ${scope.taskId}; create_task from ${sourceTaskId} is not allowed`);
  }

  const assignment = AssignmentSchema.parse(await readJson(`${MARKET}/assignments/${sourceTaskId}.json`));
  if (assignment.winner !== agent) throw new Error(`${agent} cannot create tasks from ${sourceTaskId}; not assignment winner`);
  const sourceTask = TaskSchema.parse(await readJson(`${MARKET}/tasks/${sourceTaskId}.json`));
  const repo = workDirFor(agent, sourceTaskId);
  const st = await lstat(repo).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`source worktree missing for ${sourceTaskId}`);

  const currentBranch = await gitCurrentBranch(repo);
  const baseBranch = typeof params?.base_branch === "string" && params.base_branch.trim()
    ? params.base_branch.trim()
    : currentBranch ?? sourceTask.base_branch;
  const warnings: string[] = [];
  if (!currentBranch) warnings.push("could not determine source worktree branch; using source task base_branch");

  const checks = parseDeterministicChecks(params?.deterministic_checks);
  const subjective = typeof params?.subjective_criteria === "string" && params.subjective_criteria.trim()
    ? params.subjective_criteria.trim()
    : undefined;

  return await withCreateTaskLock(async () => {
    const id = typeof params?.id === "string" && params.id.trim() ? params.id.trim() : await nextTaskId();
    if (!/^task-[0-9]{3,}$/.test(id)) throw new Error("id must look like task-NNN");
    if (await Bun.file(`${MARKET}/tasks/${id}.json`).exists()) throw new Error(`task ${id} already exists`);

    const now = new Date();
    const deadline = new Date(now.getTime() + deadlineMinutes * 60_000);
    const task = TaskSchema.parse({
      id,
      description,
      repo,
      base_branch: baseBranch,
      review_fee: reviewFee,
      deterministic_checks: checks,
      subjective_criteria: subjective,
      status: "open",
      posted_by: `agent:${agent}`,
      creator: agent,
      parent_task_id: sourceTaskId,
      posted_at: now.toISOString(),
      deadline_at: deadline.toISOString(),
    });

    debitEscrowLock(ledger, agent, reservation, `Escrow lock: ${id}`, now);
    await writeJson(`${MARKET}/tasks/${id}.json`, task);
    const reservations = await loadReservations();
    reservations[id] = reservation;
    await saveReservations(reservations);
    const escrow = await createEscrow(id, agent, reservation, now);
    await persist();
    await recordEvent(agent, now, `created task ${id} with escrow ${reservation} from ${sourceTaskId}`);
    await logEvent({ type: "agent_task_created", agent, task_id: id, parent_task_id: sourceTaskId, escrow: reservation, deadline_at: deadline.toISOString() });
    return { task, escrow, warnings };
  });
}

export async function my_created_tasks(agent: string, _params: unknown): Promise<{ tasks: any[] }> {
  const out: any[] = [];
  for (const f of await listJson(`${MARKET}/tasks`)) {
    try {
      const t = TaskSchema.parse(await readJson(`${MARKET}/tasks/${f}`));
      if (taskCreator(t) !== agent) continue;
      const escrow = await getEscrow(t.id);
      out.push({
        id: t.id,
        status: t.status,
        parent_task_id: t.parent_task_id ?? null,
        deadline_at: t.deadline_at,
        review_fee: t.review_fee,
        escrow_remaining: escrow?.remaining ?? 0,
        escrow_amount: escrow?.amount ?? 0,
        description: t.description,
      });
    } catch {}
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks: out };
}

export async function cancel_created_task(agent: string, params: any): Promise<{ task_id: string; refunded: number }> {
  const { ledger, persist } = requireLedgerAccess();
  const taskId = params?.task_id;
  if (typeof taskId !== "string") throw new Error("task_id required");
  const task = TaskSchema.parse(await readJson(`${MARKET}/tasks/${taskId}.json`));
  if (taskCreator(task) !== agent) throw new Error(`${agent} is not creator of ${taskId}`);
  if (task.status !== "open") throw new Error(`cannot cancel ${taskId}; task is ${task.status}`);
  const expired = { ...task, status: "expired" as const };
  await writeJson(`${MARKET}/tasks/${taskId}.json`, expired);
  const refunded = await refundEscrow(ledger, taskId, `Escrow refund: ${taskId} cancelled by creator`, new Date());
  await persist();
  await recordEvent(agent, new Date(), `cancelled created task ${taskId}; refunded ${refunded}`);
  await logEvent({ type: "agent_task_cancelled", agent, task_id: taskId, refunded });
  return { task_id: taskId, refunded };
}

export async function merge_task_result(agent: string, params: any): Promise<{ task_id: string; into_task_id: string; branch: string; stdout: string; stderr: string }> {
  const childTaskId = params?.task_id ?? params?.child_task_id;
  if (typeof childTaskId !== "string") throw new Error("task_id required");
  const scope = wakeScope(agent);
  const intoTaskId = typeof params?.into_task_id === "string" && params.into_task_id.trim()
    ? params.into_task_id.trim()
    : scope?.kind === "work" ? scope.taskId : undefined;
  if (!intoTaskId) throw new Error("into_task_id required unless merging into the current work wake assignment");
  assertWorkTaskAllowed(agent, intoTaskId, "merge_task_result");

  const childTask = TaskSchema.parse(await readJson(`${MARKET}/tasks/${childTaskId}.json`));
  if (taskCreator(childTask) !== agent) throw new Error(`${agent} is not creator of ${childTaskId}`);
  if (childTask.status !== "completed") throw new Error(`cannot merge ${childTaskId}; task is ${childTask.status}`);
  const assignment = AssignmentSchema.parse(await readJson(`${MARKET}/assignments/${childTaskId}.json`));

  let lgtmSeq = -1;
  for (const f of await listJson(`${MARKET}/review_responses`)) {
    try {
      const r = ReviewResponseSchema.parse(await readJson(`${MARKET}/review_responses/${f}`));
      if (r.task_id === childTaskId && r.agent === assignment.winner && r.verdict === "lgtm") lgtmSeq = Math.max(lgtmSeq, r.seq);
    } catch {}
  }
  if (lgtmSeq < 0) throw new Error(`no LGTM response found for ${childTaskId}`);
  const req = ReviewRequestSchema.parse(await readJson(`${MARKET}/review_requests/${childTaskId}-${assignment.winner}-${lgtmSeq}.json`));

  const parentDir = workDirFor(agent, intoTaskId);
  const childDir = workDirFor(assignment.winner, childTaskId);
  const fetch = Bun.spawn(["git", "-C", parentDir, "fetch", childDir, req.branch], { stdout: "pipe", stderr: "pipe" });
  const [fetchOut, fetchErr, fetchCode] = await Promise.all([new Response(fetch.stdout).text(), new Response(fetch.stderr).text(), fetch.exited]);
  if (fetchCode !== 0) throw new Error(`git fetch failed: ${fetchErr.trim()}`);
  const merge = Bun.spawn(["git", "-C", parentDir, "merge", "--no-edit", "FETCH_HEAD"], { stdout: "pipe", stderr: "pipe" });
  const [mergeOut, mergeErr, mergeCode] = await Promise.all([new Response(merge.stdout).text(), new Response(merge.stderr).text(), merge.exited]);
  if (mergeCode !== 0) throw new Error(`git merge failed: ${mergeErr.trim() || mergeOut.trim()}`);
  await logEvent({ type: "agent_task_merged", agent, task_id: childTaskId, into_task_id: intoTaskId, worker: assignment.winner, branch: req.branch });
  return { task_id: childTaskId, into_task_id: intoTaskId, branch: req.branch, stdout: fetchOut + mergeOut, stderr: fetchErr + mergeErr };
}

export async function place_bid(agent: string, params: any): Promise<{ bid: any }> {
  const scope = wakeScope(agent);
  if (scope?.kind === "work") throw new Error("place_bid is disabled during work wakes");
  const taskId = params?.task_id;
  const price = params?.price;
  if (typeof taskId !== "string") throw new Error("task_id required");
  if (typeof price !== "number" || !Number.isFinite(price) || price < 1 || !Number.isInteger(price)) {
    throw new Error("price must be a positive integer");
  }
  let task: any;
  try { task = TaskSchema.parse(await readJson(`${MARKET}/tasks/${taskId}.json`)); }
  catch { throw new Error(`task ${taskId} not found`); }
  if (task.status !== "open") throw new Error(`cannot bid on ${taskId}; task is ${task.status}`);
  if (taskCreator(task) === agent) throw new Error("creators cannot bid on their own tasks");
  const balance = await my_balance(agent, null);
  if ((balance.balance ?? 0) <= 0) throw new Error("bankrupt agents cannot bid");
  const bid = {
    task_id: taskId,
    agent,
    price,
    created_at: new Date().toISOString(),
  };
  // Validate via schema so a bad shape is caught here, not by the
  // file-watch consumer that would silently skip an invalid bid.
  BidSchema.parse(bid);
  await writeJson(`${MARKET}/bids/${taskId}-${agent}.json`, bid);
  return { bid };
}

export async function request_review(agent: string, params: any): Promise<{ request: any }> {
  const taskId = params?.task_id;
  const branch = params?.branch;
  if (typeof taskId !== "string") throw new Error("task_id required");
  if (typeof branch !== "string" || !branch) throw new Error("branch required");
  assertWorkTaskAllowed(agent, taskId, "request_review");
  const balance = await my_balance(agent, null);
  if ((balance.balance ?? 0) <= 0) throw new Error("bankrupt agents cannot request review");
  let assignment: any;
  try { assignment = AssignmentSchema.parse(await readJson(`${MARKET}/assignments/${taskId}.json`)); }
  catch { throw new Error(`no assignment for ${taskId}`); }
  if (assignment.winner !== agent) throw new Error(`${agent} is not assigned to ${taskId}`);
  let task: any;
  try { task = TaskSchema.parse(await readJson(`${MARKET}/tasks/${taskId}.json`)); }
  catch { throw new Error(`task ${taskId} not found`); }
  if (task.status !== "assigned") throw new Error(`cannot request review for ${taskId}; task is ${task.status}`);
  if (branch === task.base_branch) throw new Error(`review branch must differ from base branch '${task.base_branch}'`);
  const workDir = workDirFor(agent, taskId);
  if (!await gitRefExists(workDir, branch)) {
    throw new Error(`review branch '${branch}' not found in ${workDir}; create the branch before requesting review`);
  }
  const requestFiles = (await listJson(`${MARKET}/review_requests`))
    .filter((f) => f.startsWith(`${taskId}-${agent}-`));
  let latestRequestSeq = 0;
  for (const f of requestFiles) {
    try {
      const r = ReviewRequestSchema.parse(await readJson(`${MARKET}/review_requests/${f}`));
      latestRequestSeq = Math.max(latestRequestSeq, r.seq);
    } catch {}
  }

  let latestResponseSeq = 0;
  for (const f of (await listJson(`${MARKET}/review_responses`)).filter((f) => f.startsWith(`${taskId}-${agent}-`))) {
    try {
      const r = ReviewResponseSchema.parse(await readJson(`${MARKET}/review_responses/${f}`));
      latestResponseSeq = Math.max(latestResponseSeq, r.seq);
    } catch {}
  }
  if (latestRequestSeq > latestResponseSeq) {
    throw new Error(`review already pending for ${taskId}; wait for reviewer response`);
  }

  const seq = latestRequestSeq + 1;
  const req = {
    task_id: taskId,
    agent,
    branch,
    seq,
    requested_at: new Date().toISOString(),
  };
  ReviewRequestSchema.parse(req);
  await writeJson(`${MARKET}/review_requests/${taskId}-${agent}-${seq}.json`, req);
  return { request: req };
}

export async function my_balance(agent: string, _params: unknown): Promise<{ balance: number | null }> {
  try {
    const b = BalanceSchema.parse(await readJson(`${AGENTS_DIR}/${agent}/sandbox/balance.json`));
    return { balance: b.balance };
  } catch {
    return { balance: null };
  }
}

export async function history(agent: string, _params: unknown): Promise<{ text: string }> {
  try {
    const text = await readFile(`${HISTORY_DIR}/${agent}.md`, "utf-8");
    return { text };
  } catch {
    return { text: "" };
  }
}

export async function memory_list(agent: string, params: any): Promise<{ items: any[]; count: number; total_bytes: number; truncated: boolean; caps: any }> {
  const limit = clampPositiveInt(params?.limit, MEMORY_LIST_MAX_ITEMS, MEMORY_LIST_MAX_ITEMS);
  const items = await listMemoryItems(agent);
  const visible = items.slice(0, limit).map(({ key, bytes, updated_at }) => ({ key, bytes, updated_at }));
  return {
    items: visible,
    count: items.length,
    total_bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    truncated: items.length > visible.length,
    caps: {
      read_max_bytes: MEMORY_READ_MAX_BYTES,
      write_max_bytes: MEMORY_WRITE_MAX_BYTES,
      file_max_bytes: MEMORY_FILE_MAX_BYTES,
      total_max_bytes: MEMORY_TOTAL_MAX_BYTES,
    },
  };
}

export async function memory_read(agent: string, params: any): Promise<{ key: string; found: boolean; content: string; bytes: number; returned_bytes: number; truncated: boolean }> {
  const { key, path } = await memoryFile(agent, params?.key);
  const st = await checkedMemoryFileStat(path);
  if (!st) return { key, found: false, content: "", bytes: 0, returned_bytes: 0, truncated: false };

  const maxBytes = clampPositiveInt(params?.max_bytes, MEMORY_READ_MAX_BYTES, MEMORY_READ_MAX_BYTES);
  const buf = await readFile(path);
  const sliced = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  return {
    key,
    found: true,
    content: sliced.toString("utf-8"),
    bytes: buf.byteLength,
    returned_bytes: sliced.byteLength,
    truncated: buf.byteLength > sliced.byteLength,
  };
}

export async function memory_write(agent: string, params: any): Promise<{ key: string; mode: MemoryWriteMode; bytes_written: number; file_bytes: number; total_bytes: number }> {
  const { root, key, path } = await memoryFile(agent, params?.key);
  if (typeof params?.content !== "string") throw new Error("content required");
  const mode = parseMemoryMode(params?.mode);
  const content = params.content;
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MEMORY_WRITE_MAX_BYTES) throw new Error(`content too large; max write is ${MEMORY_WRITE_MAX_BYTES} bytes`);

  await mkdir(dirname(path), { recursive: true });
  await assertSafeMemoryAncestors(root, key);
  const existing = await checkedMemoryFileStat(path);
  const existingBytes = existing?.size ?? 0;
  const fileBytes = mode === "append" ? existingBytes + bytes : bytes;
  if (fileBytes > MEMORY_FILE_MAX_BYTES) throw new Error(`memory file too large; max file is ${MEMORY_FILE_MAX_BYTES} bytes`);

  const totalBefore = await totalMemoryBytes(agent);
  const totalAfter = totalBefore - existingBytes + fileBytes;
  if (totalAfter > MEMORY_TOTAL_MAX_BYTES) throw new Error(`memory quota exceeded; max total is ${MEMORY_TOTAL_MAX_BYTES} bytes`);

  if (mode === "append") await appendFile(path, content, "utf-8");
  else await writeFile(path, content, "utf-8");

  await logEvent({
    type: "memory_write",
    agent,
    key,
    mode,
    bytes_written: bytes,
    file_bytes: fileBytes,
    total_bytes: totalAfter,
  });

  return { key, mode, bytes_written: bytes, file_bytes: fileBytes, total_bytes: totalAfter };
}

export async function memory_edit(agent: string, params: any): Promise<{ key: string; replacements: number; bytes_before: number; bytes_after: number; total_bytes: number }> {
  const { key, path } = await memoryFile(agent, params?.key);
  if (typeof params?.old_text !== "string" || params.old_text.length === 0) throw new Error("old_text required");
  if (typeof params?.new_text !== "string") throw new Error("new_text required");

  const newTextBytes = Buffer.byteLength(params.new_text, "utf-8");
  if (newTextBytes > MEMORY_WRITE_MAX_BYTES) throw new Error(`new_text too large; max replacement is ${MEMORY_WRITE_MAX_BYTES} bytes`);

  const st = await checkedMemoryFileStat(path);
  if (!st) throw new Error(`memory '${key}' not found`);

  const text = (await readFile(path)).toString("utf-8");
  const first = text.indexOf(params.old_text);
  if (first < 0) throw new Error("old_text not found");
  const second = text.indexOf(params.old_text, first + params.old_text.length);
  if (second >= 0) throw new Error("old_text is not unique");

  const next = `${text.slice(0, first)}${params.new_text}${text.slice(first + params.old_text.length)}`;
  const bytesAfter = Buffer.byteLength(next, "utf-8");
  if (bytesAfter > MEMORY_FILE_MAX_BYTES) throw new Error(`memory file too large; max file is ${MEMORY_FILE_MAX_BYTES} bytes`);

  const totalBefore = await totalMemoryBytes(agent);
  const totalAfter = totalBefore - st.size + bytesAfter;
  if (totalAfter > MEMORY_TOTAL_MAX_BYTES) throw new Error(`memory quota exceeded; max total is ${MEMORY_TOTAL_MAX_BYTES} bytes`);

  await writeFile(path, next, "utf-8");
  await logEvent({
    type: "memory_edit",
    agent,
    key,
    bytes_before: st.size,
    bytes_after: bytesAfter,
    total_bytes: totalAfter,
  });

  return { key, replacements: 1, bytes_before: st.size, bytes_after: bytesAfter, total_bytes: totalAfter };
}

export async function memory_delete(agent: string, params: any): Promise<{ key: string; deleted: boolean; bytes_deleted: number; total_bytes: number }> {
  const { key, path } = await memoryFile(agent, params?.key);
  const st = await checkedMemoryFileStat(path);
  if (!st) return { key, deleted: false, bytes_deleted: 0, total_bytes: await totalMemoryBytes(agent) };

  await unlink(path);
  const totalAfter = await totalMemoryBytes(agent);
  await logEvent({
    type: "memory_delete",
    agent,
    key,
    bytes_deleted: st.size,
    total_bytes: totalAfter,
  });

  return { key, deleted: true, bytes_deleted: st.size, total_bytes: totalAfter };
}

export const HANDLERS = {
  list_tasks,
  task_info,
  my_assignments,
  task_verdicts,
  create_task,
  my_created_tasks,
  cancel_created_task,
  merge_task_result,
  place_bid,
  request_review,
  my_balance,
  history,
  memory_list,
  memory_read,
  memory_write,
  memory_edit,
  memory_delete,
} as const;
