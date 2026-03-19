import type { EventRow } from "./types";

type EventHandler = (event: EventRow) => void;
type StatusHandler = (connected: boolean) => void;

export function createWebSocketManager(url: string) {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const eventHandlers = new Set<EventHandler>();
  const statusHandlers = new Set<StatusHandler>();
  let connected = false;

  function notifyStatus(status: boolean) {
    connected = status;
    statusHandlers.forEach((h) => h(status));
  }

  function connect() {
    if (ws) return;

    ws = new WebSocket(url);

    ws.onopen = () => notifyStatus(true);

    ws.onmessage = (msg) => {
      try {
        const event: EventRow = JSON.parse(msg.data);
        eventHandlers.forEach((h) => h(event));
      } catch {}
    };

    ws.onclose = () => {
      ws = null;
      notifyStatus(false);
      reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
    ws = null;
    notifyStatus(false);
  }

  return {
    connect,
    disconnect,
    onEvent(handler: EventHandler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onStatus(handler: StatusHandler) {
      statusHandlers.add(handler);
      handler(connected);
      return () => statusHandlers.delete(handler);
    },
  };
}
