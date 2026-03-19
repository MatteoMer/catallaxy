import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { createToolRegistry } from "./tools/registry.js";
import { createLLMClient } from "./llm.js";
import { createAgent } from "./agent.js";
import { createServer } from "./server.js";
import { createTokenStore } from "./auth/token-store.js";
import { openTaskDb } from "./db.js";

const config = loadConfig();
const logger = createLogger(config.id, config.event_server_url);
const toolRegistry = createToolRegistry(config, logger);

// Use OAuth token store (Claude Max) when no API key is set
const tokenStore = process.env.ANTHROPIC_API_KEY ? undefined : createTokenStore();
const llm = createLLMClient(config.model, config.system_prompt, toolRegistry, logger, tokenStore);
const db = openTaskDb(config.id);
const agent = createAgent(config.id, db, llm, logger);
const app = createServer(agent);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const authMode = tokenStore ? "OAuth (Claude Max)" : "API key";
  console.log(`Agent ${config.id} listening on http://localhost:${info.port} [auth: ${authMode}]`);
});
