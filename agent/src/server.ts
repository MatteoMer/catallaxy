import { Hono } from "hono";
import { cors } from "hono/cors";
import { Mppx, tempo } from "mppx/hono";
import type { Agent } from "./agent.js";
import type { AgentConfig, IncomingMessage } from "./types.js";
import type { TaskDb } from "./db.js";

const TEMPO_TESTNET_PATHUSD = "0x20c0000000000000000000000000000000000000";

export function createServer(agent: Agent, config: AgentConfig, db: TaskDb): Hono {
  const app = new Hono();

  app.use(cors());

  const mppx = Mppx.create({
    methods: [tempo.charge({ currency: TEMPO_TESTNET_PATHUSD, recipient: config.wallet_address as `0x${string}`, testnet: true })],
    secretKey: config.wallet_private_key,
  });

  // Free — accepts messages from peers, operators, dashboard
  app.post("/message", async (c) => {
    let body: IncomingMessage;
    try {
      body = await c.req.json<IncomingMessage>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body.content !== "string" || !body.content) {
      return c.json({ error: "'content' must be a non-empty string" }, 400);
    }

    const from = typeof body.from === "string" && body.from ? body.from : "operator";
    const reward = typeof body.reward === "number" ? body.reward : 0;
    const task = agent.enqueue(from, body.content, reward, body.reply_url);
    return c.json({ task_id: task.id }, 202);
  });

  // Free — returns status only (no result field)
  app.get("/message/:id", (c) => {
    const task = agent.getTask(c.req.param("id"));
    if (!task) {
      return c.json({ error: "Message not found" }, 404);
    }
    const { result: _result, ...status } = task;
    return c.json(status);
  });

  // Paid — returns the result, 402 if not paid, 404 if not completed
  app.get("/message/:id/result", mppx.charge({ amount: config.price ?? "0.05" }), (c) => {
    const task = agent.getTask(c.req.param("id"));
    if (!task) {
      return c.json({ error: "Message not found" }, 404);
    }
    if (task.status !== "completed") {
      return c.json({ error: "Result not available yet", status: task.status }, 404);
    }
    return c.json({ result: task.result });
  });

  // Free — receives channel notifications from peers (no task creation)
  app.post("/channel/:id", async (c) => {
    let body: { from?: string; type?: string; content?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const channelId = c.req.param("id");
    const from = typeof body.from === "string" ? body.from : "unknown";
    const type = typeof body.type === "string" ? body.type : "info";
    const content = typeof body.content === "string" ? body.content : "";

    db.insertChannelMessage(channelId, from, type, content);
    return c.json({ ok: true }, 200);
  });

  app.get("/tasks/:id", (c) => {
    const task = agent.getTask(c.req.param("id"));
    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }
    return c.json(task);
  });

  app.get("/tasks", (c) => {
    return c.json(agent.listPending());
  });

  app.get("/health", (c) => {
    return c.json(agent.getState());
  });

  return app;
}
