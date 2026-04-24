import type { ToolDefinition, ToolResult } from "../types.js";

export interface TriageResult {
  accepted: boolean;
  response?: string;
}

export function getTriageTools(): {
  definitions: ToolDefinition[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  getResult: () => TriageResult | null;
} {
  let result = null as TriageResult | null;

  const definitions: ToolDefinition[] = [
    {
      name: "accept",
      description: "Accept this message and start working on it.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];

  const dispatch = async (name: string): Promise<ToolResult> => {
    if (name === "accept") {
      result = { accepted: true };
      return "Accepted. Starting work now.";
    }

    throw new Error(`Unknown triage tool: ${name}`);
  };

  const getResult = (): TriageResult | null => result;
  return { definitions, dispatch, getResult };
}
