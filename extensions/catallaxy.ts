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
 *   - create_task     create an agent-funded normal market task
 *   - my_created_tasks / cancel_created_task / merge_task_result
 *   - my_assignments  list tasks you've won and not yet completed
 *   - task_verdicts   show review verdicts you've received for a task
 *   - my_balance      show your current token balance
 *   - history         read your append-only history log (orchestrator-written)
 *   - memory_*        private persistent memory tools scoped to /sandbox/memory
 *
 * Market/economic tools talk to the orchestrator over authenticated TCP RPC
 * via CATALLAXY_RPC_ADDR. They have no direct filesystem access to market
 * state. Identity is fixed by CATALLAXY_AUTH_TOKEN, so the orchestrator
 * ignores any agent name in request payloads. Memory tools are local Pi file
 * tools scoped to /sandbox/memory.
 */

import { Type } from "@mariozechner/pi-ai";
import { createEditTool, createReadTool, createWriteTool, defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { connect } from "node:net";

/**
 * Resolve the orchestrator's RPC endpoint and auth token.
 *
 * The watcher passes both via -e at spawn time:
 *   CATALLAXY_RPC_ADDR=host:port    (the gateway in container mode)
 *   CATALLAXY_AUTH_TOKEN=<secret>   (per-agent shared secret)
 *
 * Identity is fixed by the token, not by the address — the
 * orchestrator's RPC server looks up the token to determine which
 * agent the caller is.
 */
function findRpcConfig(): { host: string; port: number; token: string } {
  const addr = process.env.CATALLAXY_RPC_ADDR;
  const token = process.env.CATALLAXY_AUTH_TOKEN;
  if (!addr) {
    throw new Error(
      "catallaxy extension: CATALLAXY_RPC_ADDR not set. The orchestrator should pass it via -e."
    );
  }
  if (!token) {
    throw new Error(
      "catallaxy extension: CATALLAXY_AUTH_TOKEN not set. The orchestrator should pass it via -e."
    );
  }
  const [host, portStr] = addr.split(":");
  const port = parseInt(portStr ?? "", 10);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`catallaxy extension: malformed CATALLAXY_RPC_ADDR '${addr}'`);
  }
  return { host, port, token };
}

interface RpcOk { id: number; result: any }
interface RpcErr { id: number; error: { code: number; message: string } }
type RpcResp = RpcOk | RpcErr;

/**
 * One TCP connection per RPC call.
 *
 * The naive design — one persistent socket reused across the
 * extension's lifetime — would keep pi's event loop alive after it
 * emits agent_end, so the container never exits. Calling `unref()`
 * on the socket fixes the hang but lets the loop exit mid-call when
 * the one-and-only HTTP-to-the-model request resolves: the next
 * tool call then races with shutdown and silently drops. Per-call
 * sockets sidestep both: each call is an active ref while in-flight
 * and the socket closes naturally on response, so when pi has no
 * outstanding work the loop drains and the process exits.
 *
 * Cost: ~one TCP handshake per tool call (sub-ms within the docker
 * bridge). Pi makes ~5–15 tool calls per wake; the overhead is
 * dwarfed by the model latency.
 */
class RpcClient {
  private nextId = 1;
  private cfg: { host: string; port: number; token: string };

  constructor(cfg: { host: string; port: number; token: string }) {
    this.cfg = cfg;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const s = connect({ host: this.cfg.host, port: this.cfg.port });
      let buf = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try { s.end(); } catch {}
        fn();
      };
      s.on("connect", () => {
        s.write(JSON.stringify({ id, method, params, auth: this.cfg.token }) + "\n");
      });
      s.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        const idx = buf.indexOf("\n");
        if (idx < 0) return;
        let msg: RpcResp;
        try { msg = JSON.parse(buf.slice(0, idx)); }
        catch (e) { finish(() => reject(e instanceof Error ? e : new Error(String(e)))); return; }
        if ("error" in msg) finish(() => reject(new Error(msg.error.message)));
        else finish(() => resolve(msg.result));
      });
      s.on("error", (err: Error) => finish(() => reject(err)));
      s.on("close", () => finish(() => reject(new Error("rpc connection closed before response"))));
    });
  }
}

let _client: RpcClient | null = null;
function rpc(): RpcClient {
  if (!_client) _client = new RpcClient(findRpcConfig());
  return _client;
}

interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
}

function addUsage(a: AgentUsage, b: AgentUsage): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheWriteTokens += b.cacheWriteTokens;
  a.totalTokens += b.totalTokens;
  a.costUsd += b.costUsd;
}

function usageFromTurnEnd(ev: any): AgentUsage | null {
  if (ev?.type !== "turn_end" || !ev.message?.usage) return null;
  const u = ev.message.usage;
  return {
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    cacheReadTokens: u.cacheRead ?? 0,
    cacheWriteTokens: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? 0,
    costUsd: u.cost?.total ?? 0,
  };
}

function textFromMessage(message: any): string {
  const chunks: string[] = [];
  for (const c of message?.content ?? []) {
    if (c?.type === "text" && typeof c.text === "string") chunks.push(c.text);
  }
  return chunks.join("\n").trim();
}

function historySummaryPrompt(rawHistory: string): string {
  return [
    "You are a terse financial analyst for a token-budgeted coding-auction agent.",
    "The agent will use your output to decide future bids. Compress the raw append-only history into actionable lessons.",
    "",
    "Rules:",
    "- Do NOT reproduce the raw log.",
    "- Use only facts present in the history. If data is missing, say so.",
    "- Keep it compact: target <= 900 words.",
    "- Emphasize losses, true total costs, wake costs, and bid floors.",
    "- Auction WON is not success; only positive net is success. LOSS is bad. Losing an auction above cost is acceptable.",
    "- Mention if the agent is wasting tokens polling/waiting after bids or reviews.",
    "",
    "Output format:",
    "# History learnings",
    "- Balance/cost trend: ...",
    "- Typical wake costs: ...",
    "- Completed task outcomes: compact bullets with paid/cost/net for recent/relevant tasks",
    "- Bidding rules for next wake: concrete bid floor guidance and when to skip",
    "- Red flags: ...",
    "",
    "Raw history follows between fences:",
    "```history",
    rawHistory,
    "```",
  ].join("\n");
}

interface HistorySummaryResult {
  text: string;
  usage: AgentUsage;
  model: string;
  summarized: boolean;
  error?: string;
}

async function summarizeHistoryWithPi(rawHistory: string): Promise<HistorySummaryResult> {
  const cfg = findRpcConfig();
  const model = process.env.CATALLAXY_HISTORY_SUMMARY_MODEL ?? process.env.AGENT_MODEL ?? "openrouter/deepseek/deepseek-v4-flash";
  const timeoutMs = Math.max(1_000, parseInt(process.env.CATALLAXY_HISTORY_SUMMARY_TIMEOUT_MS ?? "90000", 10) || 90_000);
  const maxChars = Math.max(1_000, parseInt(process.env.CATALLAXY_HISTORY_SUMMARY_MAX_CHARS ?? "8000", 10) || 8_000);

  const dir = await mkdtemp(join(tmpdir(), "catallaxy-history-"));
  const promptPath = join(dir, "prompt.md");
  await writeFile(promptPath, historySummaryPrompt(rawHistory));

  const args = [
    "--mode", "json",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--model", model,
    "--api-key", cfg.token,
    `@${promptPath}`,
  ];

  return await new Promise<HistorySummaryResult>((resolve) => {
    const usage = emptyUsage();
    let latestText = "";
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn("pi", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
    });

    const finish = (result: HistorySummaryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void rm(dir, { recursive: true, force: true });
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      finish({
        text: "",
        usage,
        model,
        summarized: false,
        error: `history summarizer timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      let idx: number;
      while ((idx = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, idx);
        stdout = stdout.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const u = usageFromTurnEnd(ev);
          if (u) addUsage(usage, u);
          if ((ev.type === "message_end" || ev.type === "turn_end") && ev.message) {
            const text = textFromMessage(ev.message);
            if (text) latestText = text;
          }
          if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
            for (const m of ev.messages) {
              if (m?.role === "assistant") {
                const text = textFromMessage(m);
                if (text) latestText = text;
              }
            }
          }
        } catch {
          // Ignore non-JSON fragments.
        }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
    proc.on("error", (err: Error) => finish({ text: "", usage, model, summarized: false, error: err.message }));
    proc.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({
          text: "",
          usage,
          model,
          summarized: false,
          error: `history summarizer exited ${code}: ${stderr.slice(0, 500)}`,
        });
        return;
      }
      const text = latestText.trim();
      if (!text) {
        finish({ text: "", usage, model, summarized: false, error: "history summarizer produced no text" });
        return;
      }
      finish({
        text: text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[summary truncated]` : text,
        usage,
        model,
        summarized: true,
      });
    });
  });
}

function historyTail(text: string): string {
  const chars = Math.max(1_000, parseInt(process.env.CATALLAXY_HISTORY_FALLBACK_CHARS ?? "6000", 10) || 6_000);
  if (text.length <= chars) return text;
  return `[history summarizer unavailable; showing last ${chars} chars of raw history]\n\n${text.slice(-chars)}`;
}

async function historyForAgent(rawHistory: string): Promise<{ text: string; details: Record<string, unknown> }> {
  if (!rawHistory.trim()) return { text: "(history empty)", details: { length: 0, summarized: false } };

  const threshold = Math.max(0, parseInt(process.env.CATALLAXY_HISTORY_SUMMARY_THRESHOLD_CHARS ?? "8000", 10) || 8_000);
  if (process.env.CATALLAXY_HISTORY_SUMMARY_DISABLE === "1" || rawHistory.length < threshold) {
    return { text: rawHistory, details: { length: rawHistory.length, summarized: false } };
  }

  const summary = await summarizeHistoryWithPi(rawHistory);
  if (!summary.summarized) {
    const fallback = historyTail(rawHistory);
    return {
      text: `${fallback}\n\n[history summarizer error: ${summary.error ?? "unknown"}]`,
      details: {
        length: rawHistory.length,
        summarized: false,
        summarizer_error: summary.error ?? "unknown",
        history_summarizer_usage: summary.usage,
        history_summarizer_model: summary.model,
      },
    };
  }

  return {
    text: summary.text,
    details: {
      length: rawHistory.length,
      summarized: true,
      raw_length: rawHistory.length,
      summary_length: summary.text.length,
      history_summarizer_usage: summary.usage,
      history_summarizer_model: summary.model,
    },
  };
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
    const { tasks } = await rpc().call("list_tasks");
    if (!tasks.length) {
      return { content: [{ type: "text", text: "No open auctions." }], details: { count: 0 } };
    }
    const now = Date.now();
    const lines = ["Open auctions:"];
    for (const t of tasks) {
      const ms = new Date(t.deadline_at).getTime() - now;
      const tl = ms < 0 ? `expired ${fmtRel(ms)} ago` : `settles in ${fmtRel(ms)}`;
      lines.push(`- ${t.id} | ${tl} | review_fee ${t.review_fee} | ${t.description}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { count: tasks.length } };
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
    const { task } = await rpc().call("task_info", { task_id: params.task_id });
    if (!task) {
      return { content: [{ type: "text", text: `task '${params.task_id}' not found` }], details: { error: "not_found" }, isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: task };
  },
});

const placeBidTool = defineTool({
  name: "place_bid",
  label: "Place a bid",
  description: "Place or update a bid on an open auction. PRICE is your declared minimum acceptable payment / cost estimate. Reverse Vickrey: lowest valid bidder wins, but payment after LGTM is the second-lowest valid bid, or the private reservation if there is only one valid bid. This tool is the ONLY way to bid — narrating 'I bid X' in text does nothing.",
  parameters: Type.Object({
    task_id: Type.String({ description: "The task ID to bid on, e.g. 'task-001'" }),
    price: Type.Integer({ minimum: 1, description: "Bid price in tokens (positive integer)" }),
  }),
  async execute(_id, params) {
    const { bid } = await rpc().call("place_bid", { task_id: params.task_id, price: params.price });
    return {
      content: [{ type: "text", text: `bid placed: ${bid.task_id} @ ${bid.price} by ${bid.agent}` }],
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
    const { request } = await rpc().call("request_review", { task_id: params.task_id, branch: params.branch });
    return {
      content: [{ type: "text", text: `review requested: ${request.task_id} #${request.seq} branch=${request.branch}` }],
      details: request,
    };
  },
});

const createTaskTool = defineTool({
  name: "create_task",
  label: "Create funded task",
  description: "Create a normal market task funded from your own balance. The reservation/max_payment is escrowed immediately from your balance. Workers pay their own review fees. When the task completes, unused escrow is refunded to you. For subtasks, create from a source assignment worktree; commit source changes first.",
  parameters: Type.Object({
    description: Type.String({ description: "Task description and acceptance requirements" }),
    max_payment: Type.Integer({ minimum: 1, description: "Maximum payment/reservation to escrow from your balance" }),
    source_task_id: Type.Optional(Type.String({ description: "Assignment task id whose worktree is the repo source; defaults to current work task during WORK wakes" })),
    base_branch: Type.Optional(Type.String({ description: "Base branch in the source worktree; defaults to current branch" })),
    review_fee: Type.Optional(Type.Integer({ minimum: 1, description: "Review fee paid by worker per review request (default 2000)" })),
    deadline_minutes: Type.Optional(Type.Integer({ minimum: 1, description: "Auction duration in minutes (default 5)" })),
    subjective_criteria: Type.Optional(Type.String({ description: "Subjective review criteria" })),
    deterministic_checks: Type.Optional(Type.Array(Type.String({ description: "Command that must pass; repeat for multiple checks" }))),
  }),
  async execute(_id, params) {
    const { task, escrow, warnings } = await rpc().call("create_task", {
      description: params.description,
      reservation: params.max_payment,
      source_task_id: params.source_task_id,
      base_branch: params.base_branch,
      review_fee: params.review_fee,
      deadline_minutes: params.deadline_minutes,
      subjective_criteria: params.subjective_criteria,
      deterministic_checks: params.deterministic_checks,
    });
    const lines = [
      `created task ${task.id}; escrowed ${escrow.amount}; deadline ${task.deadline_at}`,
      `parent/source: ${task.parent_task_id ?? "none"}; base_branch: ${task.base_branch}`,
    ];
    for (const w of warnings ?? []) lines.push(`warning: ${w}`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: { task, escrow, warnings } };
  },
});

const myCreatedTasksTool = defineTool({
  name: "my_created_tasks",
  label: "My created tasks",
  description: "List normal market tasks you created/funded, including private escrow remaining.",
  parameters: Type.Object({}),
  async execute() {
    const { tasks } = await rpc().call("my_created_tasks");
    if (!tasks.length) return { content: [{ type: "text", text: "No created tasks." }], details: { count: 0 } };
    const lines = ["Your created tasks:"];
    for (const t of tasks) {
      lines.push(`- ${t.id} (${t.status}) parent=${t.parent_task_id ?? "none"} escrow=${t.escrow_remaining}/${t.escrow_amount} deadline=${t.deadline_at} | ${t.description}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { count: tasks.length, tasks } };
  },
});

const cancelCreatedTaskTool = defineTool({
  name: "cancel_created_task",
  label: "Cancel created task",
  description: "Cancel one open unassigned task you created and refund its escrow. Assigned/completed tasks cannot be cancelled.",
  parameters: Type.Object({
    task_id: Type.String({ description: "Created task id to cancel" }),
  }),
  async execute(_id, params) {
    const result = await rpc().call("cancel_created_task", { task_id: params.task_id });
    return { content: [{ type: "text", text: `cancelled ${result.task_id}; refunded ${result.refunded}` }], details: result };
  },
});

const mergeTaskResultTool = defineTool({
  name: "merge_task_result",
  label: "Merge created task result",
  description: "Merge the LGTM branch from a completed task you created into your current assignment worktree. Commit your own current work before calling. If git reports conflicts, resolve them manually.",
  parameters: Type.Object({
    task_id: Type.String({ description: "Completed created task id to merge" }),
    into_task_id: Type.Optional(Type.String({ description: "Your assignment task to merge into; defaults to current WORK task" })),
  }),
  async execute(_id, params) {
    const result = await rpc().call("merge_task_result", { task_id: params.task_id, into_task_id: params.into_task_id });
    const text = `merged ${result.task_id} (${result.branch}) into ${result.into_task_id}\n${result.stdout}${result.stderr}`.trim();
    return { content: [{ type: "text", text }], details: result };
  },
});

const myAssignmentsTool = defineTool({
  name: "my_assignments",
  label: "My assignments",
  description: "List tasks you've been assigned (won the auction). Use this after the auction settles to know what to work on.",
  parameters: Type.Object({}),
  async execute() {
    const { assignments } = await rpc().call("my_assignments");
    if (!assignments.length) {
      return { content: [{ type: "text", text: "No assignments." }], details: { count: 0 } };
    }
    const lines = ["Your assignments:"];
    for (const a of assignments) {
      lines.push(`- ${a.task_id} (${a.task_status ?? "?"}) — paid ${a.payment} on LGTM | ${a.description ?? ""}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { count: assignments.length } };
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
    const { verdicts } = await rpc().call("task_verdicts", { task_id: params.task_id });
    if (!verdicts.length) {
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

const historyTool = defineTool({
  name: "history",
  label: "Read history",
  description: "Read your append-only history log. For large histories this tool delegates to an isolated no-tool pi subprocess and returns compact cost/bidding learnings instead of flooding your context with raw logs. The summarizer usage is still charged to your balance. You CAN'T write to history — call this tool whenever you need to consult past costs to size a bid.",
  parameters: Type.Object({}),
  async execute() {
    const { text } = await rpc().call("history");
    const result = await historyForAgent(text ?? "");
    return { content: [{ type: "text", text: result.text }], details: result.details };
  },
});

const MEMORY_KEY_MAX_CHARS = Math.max(16, parseInt(process.env.CATALLAXY_MEMORY_KEY_MAX_CHARS ?? "160", 10) || 160);
const MEMORY_WRITE_MAX_BYTES = Math.max(256, parseInt(process.env.CATALLAXY_MEMORY_WRITE_MAX_BYTES ?? "32768", 10) || 32768);
const MEMORY_LIST_MAX_ITEMS = Math.max(1, parseInt(process.env.CATALLAXY_MEMORY_LIST_MAX_ITEMS ?? "200", 10) || 200);

type MemoryItem = { key: string; bytes: number; updated_at: string };

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

function memoryRelPath(key: string): string {
  return `memory/${key}`;
}

function memoryRoot(cwd: string): string {
  return join(cwd, "memory");
}

function memoryAbsPath(cwd: string, key: string): string {
  const root = memoryRoot(cwd);
  const path = join(root, key);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..")) throw new Error("invalid memory key path");
  return path;
}

async function assertSafeMemoryAncestors(cwd: string, key: string): Promise<void> {
  const root = memoryRoot(cwd);
  await mkdir(root, { recursive: true });
  const rootSt = await lstat(root);
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) throw new Error("invalid memory root");

  let cur = root;
  for (const part of key.split("/").slice(0, -1)) {
    cur = join(cur, part);
    let st;
    try { st = await lstat(cur); } catch (e: any) {
      if (e?.code === "ENOENT") break;
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error("memory path contains a symlink");
    if (!st.isDirectory()) throw new Error("memory path parent is not a directory");
  }
}

async function listMemoryItems(cwd: string, dir = memoryRoot(cwd), prefix = ""): Promise<MemoryItem[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: MemoryItem[] = [];
  for (const ent of entries) {
    const key = prefix ? `${prefix}/${ent.name}` : ent.name;
    try { validateMemoryKey(key); } catch { continue; }
    const path = join(dir, ent.name);
    let st;
    try { st = await lstat(path); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...await listMemoryItems(cwd, path, key));
    else if (st.isFile()) out.push({ key, bytes: st.size, updated_at: st.mtime.toISOString() });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

const memoryListTool = defineTool({
  name: "memory_list",
  label: "List memory",
  description: "List your private persistent memory keys and sizes. Does not return memory contents. Use this to decide what to read or edit.",
  parameters: Type.Object({}),
  async execute(_id, _params, _signal, _onUpdate, ctx) {
    const allItems = await listMemoryItems(ctx.cwd);
    const totalBytes = allItems.reduce((sum, item) => sum + item.bytes, 0);
    const items = allItems.slice(0, MEMORY_LIST_MAX_ITEMS);
    if (!items.length) return { content: [{ type: "text", text: "Memory empty." }], details: { items, total_bytes: 0, count: 0, truncated: false } };
    const lines = [`Memory (${totalBytes} bytes):`];
    for (const item of items) lines.push(`- ${item.key} | ${item.bytes} bytes | updated ${item.updated_at}`);
    if (allItems.length > items.length) lines.push(`[truncated: ${allItems.length} total items]`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: { items, total_bytes: totalBytes, count: allItems.length, truncated: allItems.length > items.length } };
  },
});

const memoryReadTool = defineTool({
  name: "memory_read",
  label: "Read memory",
  description: "Read one private persistent memory file. Uses pi's built-in read implementation, scoped to /sandbox/memory.",
  parameters: Type.Object({
    key: Type.String({ description: "Memory key, e.g. 'core.md', 'costs.jsonl', or 'bidding.md'" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    const key = validateMemoryKey(params.key);
    await assertSafeMemoryAncestors(ctx.cwd, key);
    const tool = createReadTool(ctx.cwd);
    return tool.execute(id, { path: memoryRelPath(key), offset: params.offset, limit: params.limit }, signal, onUpdate, ctx);
  },
});

const memoryWriteTool = defineTool({
  name: "memory_write",
  label: "Write memory",
  description: "Create or overwrite one private persistent memory file. Uses pi's built-in write implementation, scoped to /sandbox/memory.",
  parameters: Type.Object({
    key: Type.String({ description: "Memory key, e.g. 'core.md', 'costs.jsonl', or 'bidding.md'" }),
    content: Type.String({ description: "Content to write" }),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    const key = validateMemoryKey(params.key);
    const bytes = Buffer.byteLength(params.content, "utf-8");
    if (bytes > MEMORY_WRITE_MAX_BYTES) throw new Error(`content too large; max write is ${MEMORY_WRITE_MAX_BYTES} bytes`);
    await assertSafeMemoryAncestors(ctx.cwd, key);
    const tool = createWriteTool(ctx.cwd);
    return tool.execute(id, { path: memoryRelPath(key), content: params.content }, signal, onUpdate, ctx);
  },
});

const memoryEditTool = defineTool({
  name: "memory_edit",
  label: "Edit memory",
  description: "Edit one private persistent memory file using pi's exact text replacement semantics, scoped to /sandbox/memory. Every oldText must match a unique non-overlapping region. Use newText='' to delete text.",
  parameters: Type.Object({
    key: Type.String({ description: "Memory key to edit" }),
    edits: Type.Array(Type.Object({
      oldText: Type.String({ description: "Exact text to replace; must be unique" }),
      newText: Type.String({ description: "Replacement text; empty string deletes oldText" }),
    })),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { key?: unknown; edits?: Array<{ oldText: string; newText: string }>; oldText?: unknown; newText?: unknown };
    if (typeof input.oldText !== "string" || typeof input.newText !== "string") return args;
    return { ...input, edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }] };
  },
  async execute(id, params, signal, onUpdate, ctx) {
    const key = validateMemoryKey(params.key);
    if (!Array.isArray(params.edits) || params.edits.length === 0) throw new Error("edits required");
    const replacementBytes = params.edits.reduce((sum, e) => sum + Buffer.byteLength(e.newText, "utf-8"), 0);
    if (replacementBytes > MEMORY_WRITE_MAX_BYTES) throw new Error(`replacement text too large; max is ${MEMORY_WRITE_MAX_BYTES} bytes`);
    await assertSafeMemoryAncestors(ctx.cwd, key);
    const tool = createEditTool(ctx.cwd);
    return tool.execute(id, { path: memoryRelPath(key), edits: params.edits }, signal, onUpdate, ctx);
  },
});

const memoryDeleteTool = defineTool({
  name: "memory_delete",
  label: "Delete memory",
  description: "Delete one private persistent memory file under /sandbox/memory.",
  parameters: Type.Object({
    key: Type.String({ description: "Memory key to delete" }),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const key = validateMemoryKey(params.key);
    await assertSafeMemoryAncestors(ctx.cwd, key);
    const path = memoryAbsPath(ctx.cwd, key);
    let st;
    try { st = await lstat(path); } catch (e: any) {
      if (e?.code === "ENOENT") return { content: [{ type: "text", text: `memory '${key}' not found` }], details: { key, deleted: false } };
      throw e;
    }
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("memory key is not a regular file");
    await unlink(path);
    return { content: [{ type: "text", text: `memory deleted: ${key} (${st.size} bytes)` }], details: { key, deleted: true, bytes_deleted: st.size } };
  },
});

const myBalanceTool = defineTool({
  name: "my_balance",
  label: "Token balance",
  description: "Show your current token balance.",
  parameters: Type.Object({}),
  async execute() {
    const { balance } = await rpc().call("my_balance");
    if (balance == null) {
      return { content: [{ type: "text", text: "balance unknown" }], details: { error: "not_found" }, isError: true };
    }
    return { content: [{ type: "text", text: `balance: ${balance} tokens` }], details: { balance } };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(listTasksTool);
  pi.registerTool(taskInfoTool);
  pi.registerTool(placeBidTool);
  pi.registerTool(requestReviewTool);
  pi.registerTool(createTaskTool);
  pi.registerTool(myCreatedTasksTool);
  pi.registerTool(cancelCreatedTaskTool);
  pi.registerTool(mergeTaskResultTool);
  pi.registerTool(myAssignmentsTool);
  pi.registerTool(taskVerdictsTool);
  pi.registerTool(myBalanceTool);
  pi.registerTool(historyTool);
  pi.registerTool(memoryListTool);
  pi.registerTool(memoryReadTool);
  pi.registerTool(memoryWriteTool);
  pi.registerTool(memoryEditTool);
  pi.registerTool(memoryDeleteTool);
}
