export const EVENT_TYPES = [
  "task_started",
  "task_completed",
  "task_failed",
  "task_enqueued",
  "bid_placed",
  "bid_accepted",
  "bid_rejected",
  "payment_sent",
  "payment_received",
  "status_changed",
  "message_sent",
  "resource_allocated",
  "resource_released",
  "llm_call",
  "llm_response",
  "tool_call",
  "tool_result",
  "peer_request",
  "peer_response",
  "peer_error",
  "worker_error",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventInput {
  timestamp: string;
  agent_id: string;
  event_type: EventType;
  data: Record<string, unknown>;
  correlation_id: string;
  causation_id?: string;
}

export interface EventRow extends EventInput {
  id: number;
}

export function validateEventInput(body: unknown): { ok: true; value: EventInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.timestamp !== "string" || obj.timestamp.length === 0) {
    return { ok: false, error: "timestamp must be a non-empty string" };
  }
  if (typeof obj.agent_id !== "string" || obj.agent_id.length === 0) {
    return { ok: false, error: "agent_id must be a non-empty string" };
  }
  if (typeof obj.event_type !== "string" || !EVENT_TYPES.includes(obj.event_type as EventType)) {
    return { ok: false, error: `event_type must be one of: ${EVENT_TYPES.join(", ")}` };
  }
  if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) {
    return { ok: false, error: "data must be a JSON object" };
  }
  if (typeof obj.correlation_id !== "string" || obj.correlation_id.length === 0) {
    return { ok: false, error: "correlation_id must be a non-empty string" };
  }
  if (obj.causation_id !== undefined && (typeof obj.causation_id !== "string" || obj.causation_id.length === 0)) {
    return { ok: false, error: "causation_id must be a non-empty string if provided" };
  }

  return {
    ok: true,
    value: {
      timestamp: obj.timestamp,
      agent_id: obj.agent_id,
      event_type: obj.event_type as EventType,
      data: obj.data as Record<string, unknown>,
      correlation_id: obj.correlation_id,
      causation_id: obj.causation_id as string | undefined,
    },
  };
}
