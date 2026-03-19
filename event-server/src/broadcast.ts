import type { WSContext } from "hono/ws";
import type { EventRow } from "./schema.js";

const clients = new Set<WSContext>();

export function addClient(ws: WSContext): void {
  clients.add(ws);
}

export function removeClient(ws: WSContext): void {
  clients.delete(ws);
}

export function broadcast(event: EventRow): void {
  const message = JSON.stringify(event);
  const dead: WSContext[] = [];
  for (const client of clients) {
    try {
      client.send(message);
    } catch {
      dead.push(client);
    }
  }
  for (const client of dead) {
    clients.delete(client);
  }
}
