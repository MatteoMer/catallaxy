import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type { EventInput, EventRow } from "./schema.js";

mkdirSync("./data", { recursive: true });

const db = new Database("./data/events.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    event_type     TEXT NOT NULL,
    data           TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    causation_id   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_agent_id       ON events (agent_id);
  CREATE INDEX IF NOT EXISTS idx_events_event_type     ON events (event_type);
  CREATE INDEX IF NOT EXISTS idx_events_correlation_id ON events (correlation_id);
`);

const insertStmt = db.prepare(`
  INSERT INTO events (timestamp, agent_id, event_type, data, correlation_id, causation_id)
  VALUES (@timestamp, @agent_id, @event_type, @data, @correlation_id, @causation_id)
`);

export function insertEvent(event: EventInput): EventRow {
  const result = insertStmt.run({
    timestamp: event.timestamp,
    agent_id: event.agent_id,
    event_type: event.event_type,
    data: JSON.stringify(event.data),
    correlation_id: event.correlation_id,
    causation_id: event.causation_id ?? null,
  });

  return { ...event, id: Number(result.lastInsertRowid) };
}

interface QueryFilters {
  agent_id?: string;
  event_type?: string;
  correlation_id?: string;
}

export function queryEvents(filters: QueryFilters): EventRow[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filters.agent_id) {
    conditions.push("agent_id = @agent_id");
    params.agent_id = filters.agent_id;
  }
  if (filters.event_type) {
    conditions.push("event_type = @event_type");
    params.event_type = filters.event_type;
  }
  if (filters.correlation_id) {
    conditions.push("correlation_id = @correlation_id");
    params.correlation_id = filters.correlation_id;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const stmt = db.prepare(`SELECT * FROM events ${where} ORDER BY id ASC LIMIT 1000`);
  const rows = stmt.all(params) as Array<Omit<EventRow, "data"> & { data: string }>;

  return rows.map((row) => ({
    ...row,
    data: JSON.parse(row.data),
  }));
}
