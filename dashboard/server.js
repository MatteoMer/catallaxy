import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";

const app = new Hono();

app.use("/*", serveStatic({ root: "./dist" }));

// SPA fallback
app.get("*", serveStatic({ root: "./dist", path: "/index.html" }));

const port = Number(process.env.PORT) || 4000;

serve({ fetch: app.fetch, port }, () => {
  console.log(`Dashboard serving on http://localhost:${port}`);
});
