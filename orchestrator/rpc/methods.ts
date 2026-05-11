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

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  TaskSchema, BidSchema, AssignmentSchema,
  ReviewRequestSchema, ReviewResponseSchema, BalanceSchema,
} from "../schemas";

const ROOT = process.cwd();
const MARKET = process.env.MARKET_DIR ?? `${ROOT}/market`;
const AGENTS_DIR = process.env.AGENTS_DIR ?? `${ROOT}/agents`;
const HISTORY_DIR = process.env.AGENT_HISTORY_DIR ?? `${ROOT}/orchestrator/private/history`;

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

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

export async function list_tasks(agent: string, _params: unknown): Promise<{ tasks: any[] }> {
  const scope = wakeScope(agent);
  if (scope?.kind === "work") throw new Error("list_tasks is disabled during work wakes");
  const out: any[] = [];
  for (const f of await listJson(`${MARKET}/tasks`)) {
    try {
      const t = TaskSchema.parse(await readJson(`${MARKET}/tasks/${f}`));
      if (t.status === "open") {
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
  const existing = (await listJson(`${MARKET}/review_requests`))
    .filter((f) => f.startsWith(`${taskId}-${agent}-`));
  const seq = existing.length + 1;
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

export const HANDLERS = {
  list_tasks,
  task_info,
  my_assignments,
  task_verdicts,
  place_bid,
  request_review,
  my_balance,
  history,
} as const;
