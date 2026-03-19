import type Anthropic from "@anthropic-ai/sdk";

// --- Config ---

export interface PeerConfig {
  id: string;
  url: string;
  description: string;
}

export interface AgentConfig {
  id: string;
  port: number;
  url: string;
  model: string;
  tools: string[];
  system_prompt: string;
  peers: PeerConfig[];
  event_server_url?: string;
}

// --- Tasks ---

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export interface Task {
  id: string;
  from: string;
  content: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  reply_url?: string;
  created_at: string;
  updated_at: string;
}

// --- Agent State ---

export interface AgentState {
  agent_id: string;
  tasks: Task[];
}

// --- Events ---

export interface Event {
  agent_id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// --- Tool System ---

export type ToolDefinition = Anthropic.Tool;

export type ToolResult = string;

export interface ToolRegistry {
  definitions: ToolDefinition[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
}

// --- Messages ---

export interface IncomingMessage {
  from: string;
  content: string;
  reply_url?: string;
}

export interface TaskResponse {
  task_id: string;
}
