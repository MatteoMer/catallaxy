import { Hono } from "hono";
import { cors } from "hono/cors";
import { Mppx, tempo } from "mppx/hono";
import type { Agent } from "./agent.js";
import type { AgentConfig, IncomingMessage } from "./types.js";

const TEMPO_TESTNET_PATHUSD = "0x20c0000000000000000000000000000000000000";

export function createServer(agent: Agent, config: AgentConfig): Hono {
  const app = new Hono();

  app.use(cors());

  const mppx = Mppx.create({
    methods: [tempo.charge({ currency: TEMPO_TESTNET_PATHUSD, recipient: config.wallet_address as `0x${string}`, testnet: true })],
    secretKey: config.wallet_private_key,
  });

  app.post("/message", mppx.charge({ amount: config.price ?? "0.05" }), async (c) => {
    let body: IncomingMessage;
    try {
      body = await c.req.json<IncomingMessage>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body.from !== "string" || !body.from) {
      return c.json({ error: "'from' must be a non-empty string" }, 400);
    }
    if (typeof body.content !== "string" || !body.content) {
      return c.json({ error: "'content' must be a non-empty string" }, 400);
    }

    const reward = typeof body.reward === "number" ? body.reward : 0;
    const task = agent.enqueue(body.from, body.content, reward, body.reply_url);
    return c.json({ task_id: task.id }, 202);
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
