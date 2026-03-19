import type { AgentConfig, ToolRegistry } from "../types.js";
import type { Logger } from "../logging.js";
import { getBuiltinTools } from "./builtins.js";
import { getPeerTools } from "./peers.js";

export function createToolRegistry(config: AgentConfig, logger: Logger): ToolRegistry {
  const builtins = getBuiltinTools(config.tools);
  const peers = getPeerTools(config.peers, config.id, logger);

  const builtinNames = new Set(builtins.definitions.map((d) => d.name));
  const peerNames = new Set(peers.definitions.map((d) => d.name));

  const definitions = [...builtins.definitions, ...peers.definitions];

  const dispatch = async (name: string, input: Record<string, unknown>): Promise<string> => {
    logger.log("tool_call", { tool: name, input });

    let result: string;
    if (builtinNames.has(name)) {
      result = await builtins.dispatch(name, input);
    } else if (peerNames.has(name)) {
      result = await peers.dispatch(name, input);
    } else {
      result = `Unknown tool: ${name}`;
    }

    logger.log("tool_result", { tool: name, result });
    return result;
  };

  return { definitions, dispatch };
}
