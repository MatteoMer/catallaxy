import type { ToolDefinition, ToolResult } from "../types.js";

interface BuiltinTool {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

const webSearch: BuiltinTool = {
  definition: {
    name: "web_search",
    description: "Search the web for information. Returns a summary of search results.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
  execute: async (input) => {
    return `[web_search stub] No results for: ${input.query}`;
  },
};

const writeCode: BuiltinTool = {
  definition: {
    name: "write_code",
    description: "Write code to a file. Creates or overwrites the file at the given path.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path to write to" },
        content: { type: "string", description: "The code content to write" },
      },
      required: ["path", "content"],
    },
  },
  execute: async (input) => {
    return `[write_code stub] Would write to: ${input.path}`;
  },
};

const readFile: BuiltinTool = {
  definition: {
    name: "read_file",
    description: "Read the contents of a file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path to read" },
      },
      required: ["path"],
    },
  },
  execute: async (input) => {
    return `[read_file stub] Would read: ${input.path}`;
  },
};

const allBuiltins: Record<string, BuiltinTool> = {
  web_search: webSearch,
  write_code: writeCode,
  read_file: readFile,
};

export function getBuiltinTools(names: string[]): {
  definitions: ToolDefinition[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
} {
  const selected = names
    .map((n) => allBuiltins[n])
    .filter((t): t is BuiltinTool => t !== undefined);

  const definitions = selected.map((t) => t.definition);

  const dispatch = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const tool = allBuiltins[name];
    if (!tool) throw new Error(`Unknown builtin tool: ${name}`);
    return tool.execute(input);
  };

  return { definitions, dispatch };
}
