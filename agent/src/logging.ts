import type { Event } from "./types.js";

export interface Logger {
  log(type: string, data: Record<string, unknown>): void;
}

export function createLogger(agentId: string, eventServerUrl?: string): Logger {
  return {
    log(type: string, data: Record<string, unknown>): void {
      const event: Event = {
        agent_id: agentId,
        type,
        data,
        timestamp: new Date().toISOString(),
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
