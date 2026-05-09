import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const ROOT = process.cwd();
const EVENTS_PATH = process.env.EVENTS_PATH ?? `${ROOT}/orchestrator/private/events.jsonl`;

export type EventLogEntry = {
  type: string;
  at?: string;
  [key: string]: unknown;
};

export async function logEvent(event: EventLogEntry): Promise<void> {
  const { type, at, ...rest } = event;
  const row = { type, at: at ?? new Date().toISOString(), ...rest };
  try {
    await mkdir(dirname(EVENTS_PATH), { recursive: true });
    await appendFile(EVENTS_PATH, `${JSON.stringify(row)}\n`);
  } catch (e) {
    console.error(`[events] failed to append ${EVENTS_PATH}:`, e);
  }
}
