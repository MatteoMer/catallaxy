import { Hono } from "hono";
import { insertEvent, queryEvents } from "../db.js";
import { broadcast } from "../broadcast.js";
import { validateEventInput } from "../schema.js";

const app = new Hono();

app.post("/events", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const result = validateEventInput(body);

  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  const row = insertEvent(result.value);
  broadcast(row);

  return c.json(row, 201);
});

app.get("/events", (c) => {
  const agent_id = c.req.query("agent_id");
  const event_type = c.req.query("event_type");
  const correlation_id = c.req.query("correlation_id");

  const rows = queryEvents({ agent_id, event_type, correlation_id });
  return c.json(rows);
});

export default app;
