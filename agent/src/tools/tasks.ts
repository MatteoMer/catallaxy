import type { ToolDefinition, ToolResult } from "../types.js";
import type { TaskDb } from "../db.js";

export interface TaskSelectionResult {
  type: "pick" | "skip";
  taskId?: string;
}

export function getTaskSelectionTools(db: TaskDb): {
  definitions: ToolDefinition[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  getSelection: () => TaskSelectionResult | null;
} {
  let selection = null as TaskSelectionResult | null;

  const definitions: ToolDefinition[] = [
    {
      name: "pick_task",
      description: "Pick a task from the queue to work on. Choose the task you can complete most effectively relative to its reward.",
      input_schema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "The ID of the task to pick" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "skip_all",
      description: "Skip all queued tasks. Use this only if none of the tasks are worth your time or match your capabilities.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];

  const dispatch = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    if (name === "pick_task") {
      const taskId = input.task_id as string;
      const task = db.getById(taskId);
      if (!task) return `Error: task ${taskId} not found`;
      if (task.status !== "queued") return `Error: task ${taskId} is not queued (status: ${task.status})`;
      selection = { type: "pick" as const, taskId };
      return `Selected task ${taskId}. Starting execution now.`;
    }

    if (name === "skip_all") {
      selection = { type: "skip" as const };
      return "Skipping all queued tasks.";
    }

    throw new Error(`Unknown task selection tool: ${name}`);
  };

  const getSelection = (): TaskSelectionResult | null => selection;
  return { definitions, dispatch, getSelection };
}
