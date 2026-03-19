import { randomUUID } from "node:crypto";
import type { Event } from "./types.js";

export interface Logger {
  log(eventType: string, data: Record<string, unknown>): void;
}

export function createLogger(agentId: string, eventServerUrl?: string): Logger {
  const tag = `[${agentId}]`;

  return {
    log(eventType: string, data: Record<string, unknown>): void {
      // Always log to stdout for docker compose logs
      console.log(`${tag} ${eventType}`, JSON.stringify(data, null, 2));

      const event: Event = {
        agent_id: agentId,
        event_type: eventType,
        data,
        timestamp: new Date().toISOString(),
        correlation_id: randomUUID(),
      };

      if (eventServerUrl) {
        fetch(`${eventServerUrl}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        }).catch(() => {});
      }
    },
  };
}
