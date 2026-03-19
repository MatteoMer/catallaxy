export interface TopologyAgent {
  id: string;
  port: number;
  role: string;
  tools: string[];
  peers: string[];
  wallet_address: string;
}

export interface EventRow {
  id: number;
  timestamp: string;
  agent_id: string;
  event_type: string;
  data: Record<string, unknown>;
  correlation_id: string;
  causation_id?: string;
}

export interface Mission {
  agentId: string;
  content: string;
  taskId?: string;
  status?: string;
  sentAt: string;
}

export type AgentRole = "research" | "coding" | "writing" | "control";

export const ROLE_COLORS: Record<AgentRole, string> = {
  research: "#22d3ee",
  coding: "#34d399",
  writing: "#a78bfa",
  control: "#fbbf24",
};

export function getRoleColor(role: string): string {
  return ROLE_COLORS[role as AgentRole] ?? "#8888a0";
}
