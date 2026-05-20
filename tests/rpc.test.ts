import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { connect } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir: string;
let stop: () => Promise<void>;
let port: number;
let aliceTok: string;
let bobTok: string;
let reviewerTok: string;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "catallaxy-rpc-"));
  // Lay down a minimal market/agents/orchestrator tree so methods
  // have files to read. The RPC server reads everything relative to
  // process.cwd() and env-overridable paths.
  await mkdir(`${workdir}/market/tasks`, { recursive: true });
  await mkdir(`${workdir}/market/bids`, { recursive: true });
  await mkdir(`${workdir}/market/assignments`, { recursive: true });
  await mkdir(`${workdir}/market/review_requests`, { recursive: true });
  await mkdir(`${workdir}/market/review_responses`, { recursive: true });
  await mkdir(`${workdir}/agents/alice/sandbox`, { recursive: true });
  await mkdir(`${workdir}/agents/bob/sandbox`, { recursive: true });
  await mkdir(`${workdir}/agents/alice/sandbox/work/task-002`, { recursive: true });
  await mkdir(`${workdir}/agents/alice/sandbox/work/task-003`, { recursive: true });
  await mkdir(`${workdir}/orchestrator/private/history`, { recursive: true });
  await writeFile(`${workdir}/orchestrator/private/audit/.keep`, "").catch(() => {});
  await mkdir(`${workdir}/orchestrator/private/audit`, { recursive: true });
  await writeFile(
    `${workdir}/agents/alice/sandbox/balance.json`,
    JSON.stringify({ balance: 12345, history: [] })
  );
  await writeFile(
    `${workdir}/orchestrator/private/history/alice.md`,
    "alice history line\n"
  );
  await writeFile(
    `${workdir}/market/tasks/task-001.json`,
    JSON.stringify({
      id: "task-001",
      description: "test task",
      repo: "/tmp/repo",
      base_branch: "main",
      review_fee: 100,
      deterministic_checks: [],
      status: "open",
      posted_by: "operator",
      posted_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    })
  );
  await writeFile(
    `${workdir}/market/tasks/task-002.json`,
    JSON.stringify({
      id: "task-002",
      description: "assigned task",
      repo: "/tmp/repo",
      base_branch: "main",
      review_fee: 100,
      deterministic_checks: [],
      status: "assigned",
      posted_by: "operator",
      posted_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    })
  );
  await writeFile(
    `${workdir}/market/tasks/task-003.json`,
    JSON.stringify({
      id: "task-003",
      description: "other assigned task",
      repo: "/tmp/repo",
      base_branch: "main",
      review_fee: 100,
      deterministic_checks: [],
      status: "assigned",
      posted_by: "operator",
      posted_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    })
  );
  await writeFile(
    `${workdir}/market/assignments/task-002.json`,
    JSON.stringify({ task_id: "task-002", winner: "alice", payment: 1000, assigned_at: new Date().toISOString() })
  );
  await writeFile(
    `${workdir}/market/assignments/task-003.json`,
    JSON.stringify({ task_id: "task-003", winner: "alice", payment: 1000, assigned_at: new Date().toISOString() })
  );
  await writeFile(
    `${workdir}/orchestrator/private/reservations.json`,
    JSON.stringify({ "task-001": 999, "task-002": 1000, "task-003": 1000 }, null, 2)
  );

  const initWorkRepo = async (repo: string, extraArgs: string[][] = []) => {
    await writeFile(`${repo}/README.md`, "source\n");
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "alice@example.test"],
      ["config", "user.name", "Alice"],
      ["add", "README.md"],
      ["commit", "-m", "init"],
      ...extraArgs,
    ]) {
      const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "pipe" });
      const err = await new Response(proc.stderr).text();
      if (await proc.exited) throw new Error(`git ${args.join(" ")} failed: ${err}`);
    }
  };
  await initWorkRepo(`${workdir}/agents/alice/sandbox/work/task-002`, [["checkout", "-b", "feature/task-002"]]);
  await initWorkRepo(`${workdir}/agents/alice/sandbox/work/task-003`);

  process.env.MARKET_DIR = `${workdir}/market`;
  process.env.AGENTS_DIR = `${workdir}/agents`;
  process.env.AGENT_HISTORY_DIR = `${workdir}/orchestrator/private/history`;
  process.env.CATALLAXY_AUDIT_DIR = `${workdir}/orchestrator/private/audit`;
  process.env.EVENTS_PATH = `${workdir}/orchestrator/private/events.jsonl`;
  process.env.RESERVATIONS_PATH = `${workdir}/orchestrator/private/reservations.json`;
  process.env.ESCROWS_PATH = `${workdir}/orchestrator/private/escrows.json`;
  // Use an ephemeral port so concurrent test runs don't collide.
  process.env.CATALLAXY_RPC_PORT = "0";

  // Late-import so the env vars above take effect when methods.ts /
  // server.ts read them at module scope.
  const { generateTokens, REVIEWER_PRINCIPAL } = await import("../orchestrator/auth");
  // A second import path with a query string would be cleaner, but
  // method/server module caches the env once. Using port 0 is the
  // workaround — the OS picks a free port and Bun.listen reports it.
  // Bun.listen(unix? port? still need a way to recover the chosen
  // port). Instead, claim a high random port up-front.
  const tryPort = 9000 + Math.floor(Math.random() * 500);
  process.env.CATALLAXY_RPC_PORT = String(tryPort);
  port = tryPort;

  const { startRpcServer } = await import("../orchestrator/rpc/server");
  const { setLedgerAccess } = await import("../orchestrator/rpc/methods");
  const ledger = { alice: { balance: 12345, history: [] } } as any;
  setLedgerAccess(ledger, async () => {
    await writeFile(`${workdir}/orchestrator/ledger.json`, JSON.stringify(ledger, null, 2));
    await writeFile(`${workdir}/agents/alice/sandbox/balance.json`, JSON.stringify(ledger.alice, null, 2));
  });
  const tokens = generateTokens(["alice", "bob"]);
  aliceTok = tokens.byAgent.get("alice")!;
  bobTok = tokens.byAgent.get("bob")!;
  reviewerTok = tokens.byAgent.get(REVIEWER_PRINCIPAL)!;
  const handle = await startRpcServer(tokens);
  stop = handle.stop;
});

afterAll(async () => {
  await stop();
  await rm(workdir, { recursive: true, force: true });
});

async function rpc(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    let buf = "";
    s.on("data", (c) => {
      buf += c.toString();
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        try { resolve(JSON.parse(buf.slice(0, idx))); }
        catch (e) { reject(e); }
        s.end();
      }
    });
    s.on("error", reject);
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
  });
}

describe("RPC end-to-end", () => {
  test("valid token returns task list", async () => {
    const r = await rpc({ id: 1, method: "list_tasks", auth: aliceTok });
    expect(r.id).toBe(1);
    expect(r.result.tasks).toHaveLength(1);
    expect(r.result.tasks[0].id).toBe("task-001");
    expect(r.result.tasks[0].reservation).toBe(999);
  });

  test("task_info exposes reservation", async () => {
    const r = await rpc({ id: 101, method: "task_info", auth: aliceTok, params: { task_id: "task-001" } });
    expect(r.result.task.id).toBe("task-001");
    expect(r.result.task.reservation).toBe(999);
  });

  test("missing auth → UNAUTHORIZED", async () => {
    const r = await rpc({ id: 2, method: "list_tasks" });
    expect(r.error.code).toBe(7);
  });

  test("wrong token → UNAUTHORIZED", async () => {
    const r = await rpc({ id: 3, method: "list_tasks", auth: "deadbeef" });
    expect(r.error.code).toBe(7);
  });

  test("reviewer token rejected from RPC", async () => {
    const r = await rpc({ id: 4, method: "list_tasks", auth: reviewerTok });
    expect(r.error.code).toBe(7);
  });

  test("unknown method → UNKNOWN_METHOD", async () => {
    const r = await rpc({ id: 5, method: "nope", auth: aliceTok });
    expect(r.error.code).toBe(3);
  });

  test("place_bid validates params", async () => {
    const r = await rpc({
      id: 6, method: "place_bid", auth: aliceTok,
      params: { task_id: "task-001", price: 0 },
    });
    expect(r.error.code).toBe(4);
  });

  test("place_bid writes bid file under correct agent", async () => {
    const r = await rpc({
      id: 7, method: "place_bid", auth: aliceTok,
      params: { task_id: "task-001", price: 500 },
    });
    expect(r.result.bid.agent).toBe("alice");
    expect(r.result.bid.price).toBe(500);
    const bid = JSON.parse(
      await Bun.file(`${workdir}/market/bids/task-001-alice.json`).text()
    );
    expect(bid.agent).toBe("alice");
  });

  test("my_balance returns the agent's balance.json contents", async () => {
    const r = await rpc({ id: 8, method: "my_balance", auth: aliceTok });
    expect(r.result.balance).toBe(12345);
  });

  test("my_balance for bob (no balance.json) returns null", async () => {
    const r = await rpc({ id: 9, method: "my_balance", auth: bobTok });
    expect(r.result.balance).toBe(null);
  });

  test("history returns the orchestrator-written log", async () => {
    const r = await rpc({ id: 10, method: "history", auth: aliceTok });
    expect(r.result.text).toContain("alice history line");
  });

  test("create_task escrows creator funds and prevents creator self-bids", async () => {
    const { setWakeScope, clearWakeScope } = await import("../orchestrator/rpc/methods");
    setWakeScope("alice", { kind: "work", taskId: "task-002" });
    let createdId = "";
    try {
      const created = await rpc({
        id: 120,
        method: "create_task",
        auth: aliceTok,
        params: {
          description: "child task from alice",
          max_payment: 1000,
          deterministic_checks: ["bun test"],
        },
      });
      expect(created.result.task.creator).toBe("alice");
      expect(created.result.task.parent_task_id).toBe("task-002");
      expect(created.result.escrow.amount).toBe(1000);
      createdId = created.result.task.id;
    } finally {
      clearWakeScope("alice");
    }

    const afterCreate = JSON.parse(await Bun.file(`${workdir}/agents/alice/sandbox/balance.json`).text());
    expect(afterCreate.balance).toBe(11345);
    const reservations = JSON.parse(await Bun.file(`${workdir}/orchestrator/private/reservations.json`).text());
    expect(reservations[createdId]).toBe(1000);

    const selfBid = await rpc({
      id: 121,
      method: "place_bid",
      auth: aliceTok,
      params: { task_id: createdId, price: 500 },
    });
    expect(selfBid.error.message).toContain("creators cannot bid");

    const mine = await rpc({ id: 122, method: "my_created_tasks", auth: aliceTok });
    expect(mine.result.tasks.some((t: any) => t.id === createdId && t.escrow_remaining === 1000)).toBe(true);

    const cancelled = await rpc({
      id: 123,
      method: "cancel_created_task",
      auth: aliceTok,
      params: { task_id: createdId },
    });
    expect(cancelled.result.refunded).toBe(1000);
    const afterCancel = JSON.parse(await Bun.file(`${workdir}/agents/alice/sandbox/balance.json`).text());
    expect(afterCancel.balance).toBe(12345);
  });

  test("memory_write/read/edit/delete are private and persistent", async () => {
    const write = await rpc({
      id: 101,
      method: "memory_write",
      auth: aliceTok,
      params: { key: "core.md", mode: "replace", content: "Bid floor for strings: 120000 tokens\n" },
    });
    expect(write.result.key).toBe("core.md");
    expect(write.result.bytes_written).toBeGreaterThan(0);

    const append = await rpc({
      id: 102,
      method: "memory_write",
      auth: aliceTok,
      params: { key: "core.md", mode: "append", content: "Delete stale notes when wrong.\n" },
    });
    expect(append.result.file_bytes).toBeGreaterThan(write.result.file_bytes);

    const read = await rpc({
      id: 103,
      method: "memory_read",
      auth: aliceTok,
      params: { key: "core.md" },
    });
    expect(read.result.content).toContain("Bid floor");
    expect(read.result.content).toContain("Delete stale");

    const edit = await rpc({
      id: 104,
      method: "memory_edit",
      auth: aliceTok,
      params: { key: "core.md", old_text: "Delete stale notes when wrong.\n", new_text: "" },
    });
    expect(edit.result.bytes_after).toBeLessThan(edit.result.bytes_before);

    const edited = await rpc({
      id: 105,
      method: "memory_read",
      auth: aliceTok,
      params: { key: "core.md" },
    });
    expect(edited.result.content).not.toContain("Delete stale");

    const bobList = await rpc({ id: 106, method: "memory_list", auth: bobTok });
    expect(bobList.result.items).toHaveLength(0);

    const del = await rpc({
      id: 107,
      method: "memory_delete",
      auth: aliceTok,
      params: { key: "core.md" },
    });
    expect(del.result.deleted).toBe(true);
  });

  test("memory rejects traversal and oversized writes", async () => {
    const traversal = await rpc({
      id: 108,
      method: "memory_read",
      auth: aliceTok,
      params: { key: "../balance.json" },
    });
    expect(traversal.error.message).toContain("invalid memory key");

    const tooLarge = await rpc({
      id: 109,
      method: "memory_write",
      auth: aliceTok,
      params: { key: "big.md", mode: "replace", content: "x".repeat(40000) },
    });
    expect(tooLarge.error.message).toContain("content too large");
  });

  test("request_review rejects missing or base branches", async () => {
    const { setWakeScope, clearWakeScope } = await import("../orchestrator/rpc/methods");
    setWakeScope("alice", { kind: "work", taskId: "task-003" });
    try {
      const missing = await rpc({
        id: 112,
        method: "request_review",
        auth: aliceTok,
        params: { task_id: "task-003", branch: "does-not-exist" },
      });
      expect(missing.error.message).toContain("not found");

      const base = await rpc({
        id: 113,
        method: "request_review",
        auth: aliceTok,
        params: { task_id: "task-003", branch: "main" },
      });
      expect(base.error.message).toContain("must differ from base branch");
    } finally {
      clearWakeScope("alice");
    }
  });

  test("request_review rejects duplicate pending requests", async () => {
    const { setWakeScope, clearWakeScope } = await import("../orchestrator/rpc/methods");
    setWakeScope("alice", { kind: "work", taskId: "task-002" });
    try {
      const first = await rpc({
        id: 110,
        method: "request_review",
        auth: aliceTok,
        params: { task_id: "task-002", branch: "feature/task-002" },
      });
      expect(first.result.request.seq).toBe(1);

      const second = await rpc({
        id: 111,
        method: "request_review",
        auth: aliceTok,
        params: { task_id: "task-002", branch: "feature/task-002" },
      });
      expect(second.error.message).toContain("review already pending");
    } finally {
      clearWakeScope("alice");
    }
  });

  test("work wake scope hides other assignments and rejects other task actions", async () => {
    const { setWakeScope, clearWakeScope } = await import("../orchestrator/rpc/methods");
    setWakeScope("alice", { kind: "work", taskId: "task-002" });
    try {
      const assignments = await rpc({ id: 11, method: "my_assignments", auth: aliceTok });
      expect(assignments.result.assignments.map((a: any) => a.task_id)).toEqual(["task-002"]);

      const otherInfo = await rpc({
        id: 12, method: "task_info", auth: aliceTok,
        params: { task_id: "task-003" },
      });
      expect(otherInfo.error.message).toContain("scoped to task-002");

      const otherVerdicts = await rpc({
        id: 13, method: "task_verdicts", auth: aliceTok,
        params: { task_id: "task-003" },
      });
      expect(otherVerdicts.error.message).toContain("scoped to task-002");

      const list = await rpc({ id: 14, method: "list_tasks", auth: aliceTok });
      expect(list.error.message).toContain("disabled during work wakes");

      const bid = await rpc({
        id: 15, method: "place_bid", auth: aliceTok,
        params: { task_id: "task-001", price: 500 },
      });
      expect(bid.error.message).toContain("disabled during work wakes");
    } finally {
      clearWakeScope("alice");
    }
  });

  test("connection-pinning: alice's token can't switch to bob mid-stream", async () => {
    // First frame establishes alice; second frame with bob's token
    // is rejected.
    const conn = connect({ host: "127.0.0.1", port });
    await new Promise<void>((res) => conn.on("connect", () => res()));
    const replies: string[] = [];
    conn.on("data", (c) => replies.push(c.toString()));
    conn.write(JSON.stringify({ id: 1, method: "list_tasks", auth: aliceTok }) + "\n");
    conn.write(JSON.stringify({ id: 2, method: "list_tasks", auth: bobTok }) + "\n");
    await new Promise((r) => setTimeout(r, 200));
    conn.end();
    const lines = replies.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const r1 = lines.find((l: any) => l.id === 1);
    const r2 = lines.find((l: any) => l.id === 2);
    expect(r1.result).toBeDefined();
    expect(r2.error.code).toBe(7);
  });
});
