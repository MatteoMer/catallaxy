import type Anthropic from "@anthropic-ai/sdk";

/**
 * Maps config tool names to Anthropic server tool definitions.
 *
 * Server tools (web_search, code_execution) are executed by Anthropic's API
 * server-side — we just declare them and the results come back as content
 * blocks in the response. No client-side dispatch needed.
 */

type ServerTool = Anthropic.Messages.WebSearchTool20250305 | Anthropic.Messages.CodeExecutionTool20250522;

const serverTools: Record<string, ServerTool> = {
  web_search: {
    name: "web_search",
    type: "web_search_20250305",
  },
  code_execution: {
    name: "code_execution",
    type: "code_execution_20250522",
  },
};

export function getBuiltinTools(names: string[]): {
  definitions: Anthropic.Messages.ToolUnion[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<string>;
} {
  const definitions: Anthropic.Messages.ToolUnion[] = [];

  for (const name of names) {
    const tool = serverTools[name];
    if (tool) {
      definitions.push(tool);
    }
  }

  // Server tools don't need client-side dispatch — Anthropic handles execution.
  // This dispatch is only called for client-side tool_use blocks, which server
  // tools never produce.
  const dispatch = async (name: string): Promise<string> => {
    throw new Error(`Unexpected client dispatch for server tool: ${name}`);
  };

  return { definitions, dispatch };
}
