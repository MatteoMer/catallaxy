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
  wallet_address: string;
  wallet_private_key: string;
  price?: string;
}

// --- Tasks ---

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export interface Task {
  id: string;
  from: string;
  content: string;
  status: TaskStatus;
  reward: number;
  result?: string;
  error?: string;
  reply_url?: string;
  created_at: string;
  updated_at: string;
}

// --- Agent State ---

export interface AgentState {
  agent_id: string;
  pending_task_count: number;
  current_task?: { id: string; from: string; content: string; reward: number };
}

// --- Events ---

export interface Event {
  agent_id: string;
  event_type: string;
  data: Record<string, unknown>;
  timestamp: string;
  correlation_id: string;
}

// --- Tool System ---

export type ToolDefinition = Anthropic.Messages.ToolUnion;

export type ToolResult = string;

export interface ToolRegistry {
  definitions: ToolDefinition[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
}

// --- Messages ---

export interface IncomingMessage {
  from: string;
  content: string;
  reward?: number;
  reply_url?: string;
}

export interface TaskResponse {
  task_id: string;
}
