/**
 * RPC audit log — append-only record of every RPC call.
 *
 * Stored at orchestrator/private/audit/{agent}.jsonl, outside the
 * agent's sandbox, so the agent has no read or write path to its
 * own audit trail. Useful for forensics: who called what, when,
 * with what arguments, and what the result was.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const AUDIT_DIR = process.env.CATALLAXY_AUDIT_DIR
  ?? `${process.cwd()}/orchestrator/private/audit`;

export interface AuditEntry {
  agent: string;
  method: string;
  paramsHash: string;
  ok: boolean;
  errCode?: number;
  errMessage?: string;
  at: string;
}

let initialized = false;
async function ensureDir(): Promise<void> {
  if (initialized) return;
  await mkdir(AUDIT_DIR, { recursive: true });
  initialized = true;
}

export function hashParams(params: unknown): string {
  try {
    return createHash("sha256").update(JSON.stringify(params ?? null)).digest("hex").slice(0, 16);
  } catch {
    return "unhashable";
  }
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await ensureDir();
    await appendFile(`${AUDIT_DIR}/${entry.agent}.jsonl`, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error(`[audit] write failed:`, e);
  }
}
