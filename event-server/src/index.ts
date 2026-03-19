import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import eventRoutes from "./routes/events.js";
import { setupWebSocket } from "./routes/ws.js";

const app = new Hono();

app.use(cors());
app.use(logger());

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/topology", (c) => {
  const raw = process.env.NETWORK_TOPOLOGY;
  if (!raw) return c.json([], 200);
  try {
    return c.json(JSON.parse(raw));
  } catch {
    return c.json({ error: "Invalid NETWORK_TOPOLOGY" }, 500);
  }
});

app.route("/", eventRoutes);

const { injectWebSocket } = setupWebSocket(app);

const port = Number(process.env.PORT) || 4100;

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Event server listening on http://localhost:${port}`);
});

injectWebSocket(server);
