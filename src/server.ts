import { Hono } from "hono";
import type { Agent } from "./agent.js";
import type { IncomingMessage } from "./types.js";

export function createServer(agent: Agent): Hono {
  const app = new Hono();

  app.post("/message", async (c) => {
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

    const task = agent.enqueue(body.from, body.content);
    return c.json({ task_id: task.id }, 202);
  });

  app.get("/tasks/:id", (c) => {
    const task = agent.getTask(c.req.param("id"));
    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }
    return c.json(task);
  });

  app.get("/health", (c) => {
    return c.json(agent.getState());
  });

  return app;
}
