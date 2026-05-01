/**
 * Egress proxy audit log — append-only record of every upstream call.
 *
 * Stored at orchestrator/private/audit/proxy-{agent}.jsonl. Captures
 * method, path, status, response bytes (if available), and any
 * upstream token usage we can extract from the response. The agent
 * has no read or write path here.
 */

import { mkdir, appendFile } from "node:fs/promises";

const AUDIT_DIR = process.env.CATALLAXY_AUDIT_DIR
  ?? `${process.cwd()}/orchestrator/private/audit`;

export interface ProxyAuditEntry {
  agent: string;
  method: string;
  path: string;
  status: number;
  bytesIn: number;
  bytesOut: number;
  at: string;
}

let initialized = false;
async function ensureDir(): Promise<void> {
  if (initialized) return;
  await mkdir(AUDIT_DIR, { recursive: true });
  initialized = true;
}

export async function recordProxyAudit(entry: ProxyAuditEntry): Promise<void> {
  try {
    await ensureDir();
    await appendFile(`${AUDIT_DIR}/proxy-${entry.agent}.jsonl`, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error(`[proxy-audit] write failed:`, e);
  }
}
