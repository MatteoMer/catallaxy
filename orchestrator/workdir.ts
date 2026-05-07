/**
 * Per-agent working clones.
 *
 * Each agent gets a private clone of `task.repo` at
 * `agents/{agent}/sandbox/work/{task_id}/` so they don't race on a
 * shared working tree, and so the reviewer has a known path to read
 * the diff from. The clone is created at assignment time (before the
 * agent's first wake fires) and reused across iterations.
 */

import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Task } from "./schemas";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "./agents";

export function workDirFor(agent: string, taskId: string): string {
  return `${AGENTS_DIR}/${agent}/sandbox/work/${taskId}`;
}

/**
 * Clone task.repo into the agent's work dir if not already present.
 * Idempotent. Throws on git clone failure (caller should surface the
 * error rather than silently leave the agent without a work tree).
 */
export async function prepareWorkDir(agent: string, task: Task): Promise<string> {
  const dir = workDirFor(agent, task.id);
  if (existsSync(`${dir}/.git`)) return dir;
  if (existsSync(dir)) await rm(dir, { recursive: true, force: true });

  await mkdir(dir, { recursive: true });
  const proc = Bun.spawn(["git", "clone", task.repo, dir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git clone failed for ${task.id} → ${dir}: ${err.trim()}`);
  }
  return dir;
}
