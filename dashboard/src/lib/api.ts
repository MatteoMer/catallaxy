import type { TopologyAgent, EventRow } from "./types";

const EVENT_SERVER = import.meta.env.DEV ? "/api" : "http://localhost:4100";

export async function fetchTopology(): Promise<TopologyAgent[]> {
  const res = await fetch(`${EVENT_SERVER}/topology`);
  if (!res.ok) throw new Error("Failed to fetch topology");
  return res.json();
}

export async function fetchEvents(params?: {
  agent_id?: string;
  event_type?: string;
}): Promise<EventRow[]> {
  const qs = new URLSearchParams();
  if (params?.agent_id) qs.set("agent_id", params.agent_id);
  if (params?.event_type) qs.set("event_type", params.event_type);
  const res = await fetch(`${EVENT_SERVER}/events?${qs}`);
  if (!res.ok) throw new Error("Failed to fetch events");
  return res.json();
}

export async function sendMission(
  agentPort: number,
  content: string
): Promise<{ task_id: string }> {
  const res = await fetch(`http://localhost:${agentPort}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "operator", content }),
  });
  if (!res.ok) throw new Error("Failed to send mission");
  return res.json();
}

export async function fetchTaskStatus(
  agentPort: number,
  taskId: string
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://localhost:${agentPort}/tasks/${taskId}`);
  if (!res.ok) throw new Error("Failed to fetch task status");
  return res.json();
}
