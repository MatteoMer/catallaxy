/**
 * catallaxy market tools — registered as proper pi tools so the model
 * sees them in its tool list and uses them natively, instead of having
 * to remember to invoke shell commands via bash.
 *
 * Loaded by watch.ts via `pi -e <abs-path-to-this-file>`.
 *
 * Tools:
 *   - list_tasks      list currently open auctions
 *   - task_info       full details of one task
 *   - place_bid       place / update a bid
 *   - request_review  ask the reviewer to look at your branch
 *   - my_assignments  list tasks you've won and not yet completed
 *   - task_verdicts   show review verdicts you've received for a task
 *   - my_balance      show your current token balance
 *
 * The agent's CWD is its sandbox (agents/{name}/sandbox/), where
 * identity.json and balance.json live. Market state lives at
 * <catallaxy_root>/market/, resolved via this file's directory.
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = dirname(fileURLToPath(import.meta.url));
const CATALLAXY_ROOT = join(baseDir, "..");
const MARKET = join(CATALLAXY_ROOT, "market");

async function readJson<T = any>(path: string): Promise<T> {
  const text = await readFile(path, "utf-8");
  return JSON.parse(text) as T;
}

async function writeJson(path: string, data: any): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

async function readIdentity(): Promise<string> {
  const id = await readJson<{ name?: string }>("identity.json");
  if (!id?.name) throw new Error("identity.json missing 'name' field");
  return id.name;
}

function fmtRel(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 1000))}s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
  return `${Math.round(abs / 86_400_000)}d`;
}

const listTasksTool = defineTool({
  name: "list_tasks",
  label: "List open auctions",
  description: "List currently open catallaxy auctions you can bid on. Returns id, time-to-deadline, review_fee, and description.",
  parameters: Type.Object({}),
  async execute() {
    const files = await readdir(`${MARKET}/tasks`).catch(() => [] as string[]);
    const tasks: any[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try { tasks.push(await readJson(`${MARKET}/tasks/${f}`)); } catch {}
    }
    const open = tasks.filter((t) => t?.status === "open");
    if (open.length === 0) {
      return { content: [{ type: "text", text: "No open auctions." }], details: { count: 0 } };
    }
    const now = Date.now();
    const lines = ["Open auctions:"];
    for (const t of open) {
      const ms = new Date(t.deadline_at).getTime() - now;
      const tl = ms < 0 ? `expired ${fmtRel(ms)} ago` : `settles in ${fmtRel(ms)}`;
      lines.push(`- ${t.id} | ${tl} | review_fee ${t.review_fee} | ${t.description}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { count: open.length } };
  },
});

const taskInfoTool = defineTool({
  name: "task_info",
  label: "Task details",
  description: "Full details of a single task: description, repo, base_branch, review_fee, deterministic_checks, subjective_criteria, deadline.",
  parameters: Type.Object({
    task_id: Type.String({ description: "The task ID, e.g. 'task-001'" }),
  }),
  async execute(_id, params) {
    try {
      const t = await readJson(`${MARKET}/tasks/${params.task_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify(t, null, 2) }], details: t };
    } catch {
      return { content: [{ type: "text", text: `task '${params.task_id}' not found` }], details: { error: "not_found" }, isError: true };
    }
  },
});

const placeBidTool = defineTool({
  name: "place_bid",
  label: "Place a bid",
  description: "Place or update a bid on an open auction. PRICE is the number of tokens you accept to do the work, paid only after LGTM. This tool is the ONLY way to bid — narrating 'I bid X' in text does nothing.",
  parameters: Type.Object({
    task_id: Type.String({ description: "The task ID to bid on, e.g. 'task-001'" }),
    price: Type.Integer({ minimum: 1, description: "Bid price in tokens (positive integer)" }),
  }),
  async execute(_id, params) {
    const agent = await readIdentity();
    const bid = {
      task_id: params.task_id,
      agent,
      price: params.price,
      created_at: new Date().toISOString(),
    };
    await writeJson(`${MARKET}/bids/${params.task_id}-${agent}.json`, bid);
    return {
      content: [{ type: "text", text: `bid placed: ${params.task_id} @ ${params.price} by ${agent}` }],
      details: bid,
    };
  },
});

const requestReviewTool = defineTool({
  name: "request_review",
  label: "Request review",
  description: "Request a review of your work for a task you've been assigned. Each call debits review_fee. The reviewer reads your work from agents/{your_name}/sandbox/work/{task_id}/ on the named branch.",
  parameters: Type.Object({
    task_id: Type.String({ description: "The task ID, e.g. 'task-001'" }),
    branch: Type.String({ description: "Git branch in your work tree, e.g. 'fix/palindrome'" }),
  }),
  async execute(_id, params) {
    const agent = await readIdentity();
    let existing: string[] = [];
    try { existing = await readdir(`${MARKET}/review_requests`); } catch {}
    const matching = existing.filter(
      (f) => f.startsWith(`${params.task_id}-${agent}-`) && f.endsWith(".json")
    );
    const seq = matching.length + 1;
    const req = {
      task_id: params.task_id,
      agent,
      branch: params.branch,
      seq,
      requested_at: new Date().toISOString(),
    };
    await writeJson(`${MARKET}/review_requests/${params.task_id}-${agent}-${seq}.json`, req);
    return {
      content: [{ type: "text", text: `review requested: ${params.task_id} #${seq} branch=${params.branch}` }],
      details: req,
    };
  },
});

const myAssignmentsTool = defineTool({
  name: "my_assignments",
  label: "My assignments",
  description: "List tasks you've been assigned (won the auction). Use this after the auction settles to know what to work on.",
  parameters: Type.Object({}),
  async execute() {
    const agent = await readIdentity();
    const files = await readdir(`${MARKET}/assignments`).catch(() => [] as string[]);
    const mine: any[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const a = await readJson<any>(`${MARKET}/assignments/${f}`);
        if (a?.winner !== agent) continue;
        const t = await readJson<any>(`${MARKET}/tasks/${a.task_id}.json`).catch(() => null);
        mine.push({ ...a, task_status: t?.status, description: t?.description });
      } catch {}
    }
    if (mine.length === 0) {
      return { content: [{ type: "text", text: "No assignments." }], details: { count: 0 } };
    }
    const lines = ["Your assignments:"];
    for (const a of mine) {
      lines.push(`- ${a.task_id} (${a.task_status ?? "?"}) — paid ${a.payment} on LGTM | ${a.description ?? ""}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { count: mine.length } };
  },
});

const taskVerdictsTool = defineTool({
  name: "task_verdicts",
  label: "Review verdicts",
  description: "Show review verdicts and feedback you've received for a given task.",
  parameters: Type.Object({
    task_id: Type.String({ description: "The task ID, e.g. 'task-001'" }),
  }),
  async execute(_id, params) {
    const agent = await readIdentity();
    const files = await readdir(`${MARKET}/review_responses`).catch(() => [] as string[]);
    const verdicts: any[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = await readJson<any>(`${MARKET}/review_responses/${f}`);
        if (r?.task_id === params.task_id && r?.agent === agent) verdicts.push(r);
      } catch {}
    }
    verdicts.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    if (verdicts.length === 0) {
      return { content: [{ type: "text", text: `No verdicts for ${params.task_id}.` }], details: { count: 0 } };
    }
    const lines: string[] = [];
    for (const v of verdicts) {
      lines.push(`#${v.seq} — ${v.verdict} (${v.reviewed_at})`);
      lines.push(v.feedback);
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { count: verdicts.length } };
  },
});

const myBalanceTool = defineTool({
  name: "my_balance",
  label: "Token balance",
  description: "Show your current token balance.",
  parameters: Type.Object({}),
  async execute() {
    try {
      const b = await readJson<{ balance?: number }>("balance.json");
      return { content: [{ type: "text", text: `balance: ${b.balance ?? 0} tokens` }], details: b };
    } catch {
      return { content: [{ type: "text", text: "balance.json not found" }], details: { error: "not_found" }, isError: true };
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(listTasksTool);
  pi.registerTool(taskInfoTool);
  pi.registerTool(placeBidTool);
  pi.registerTool(requestReviewTool);
  pi.registerTool(myAssignmentsTool);
  pi.registerTool(taskVerdictsTool);
  pi.registerTool(myBalanceTool);
}
