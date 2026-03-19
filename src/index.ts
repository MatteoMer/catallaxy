import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { createToolRegistry } from "./tools/registry.js";
import { createLLMClient } from "./llm.js";
import { createAgent } from "./agent.js";
import { createServer } from "./server.js";

const config = loadConfig();
const logger = createLogger(config.id, config.event_server_url);
const toolRegistry = createToolRegistry(config, logger);
const llm = createLLMClient(config.model, config.system_prompt, toolRegistry, logger);
const agent = createAgent(config.id, llm, logger);
const app = createServer(agent);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Agent ${config.id} listening on http://localhost:${info.port}`);
});
