import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { addClient, removeClient } from "../broadcast.js";

export function setupWebSocket(app: Hono) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        addClient(ws);
      },
      onClose(_event, ws) {
        removeClient(ws);
      },
      onError(_event, ws) {
        removeClient(ws);
      },
    }))
  );

  return { injectWebSocket };
}
