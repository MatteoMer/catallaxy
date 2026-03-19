import { useState, useEffect, useRef, useCallback } from "react";
import { createWebSocketManager } from "../lib/ws";
import { fetchEvents } from "../lib/api";
import type { EventRow } from "../lib/types";

const MAX_EVENTS = 500;

const wsUrl = import.meta.env.DEV
  ? `ws://${window.location.host}/api/ws`
  : "ws://localhost:4100/ws";

export function useEventStream() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [connected, setConnected] = useState(false);
  const managerRef = useRef<ReturnType<typeof createWebSocketManager> | null>(null);

  const addEvent = useCallback((event: EventRow) => {
    setEvents((prev) => {
      const next = [event, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  useEffect(() => {
    // Backfill existing events
    fetchEvents()
      .then((rows) => {
        setEvents(rows.reverse().slice(0, MAX_EVENTS));
      })
      .catch(() => {});

    // Connect WebSocket
    const manager = createWebSocketManager(wsUrl);
    managerRef.current = manager;

    const unsubEvent = manager.onEvent(addEvent);
    const unsubStatus = manager.onStatus(setConnected);

    manager.connect();

    return () => {
      unsubEvent();
      unsubStatus();
      manager.disconnect();
    };
  }, [addEvent]);

  return { events, connected };
}
