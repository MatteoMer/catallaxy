/**
 * Per-agent working clones.
 *
 * Each agent gets a private clone of `task.repo` at
 * `agents/{agent}/sandbox/work/{task_id}/` so they don't race on a
 * shared working tree, and so the reviewer has a known path to read
 * the diff from. The clone is created at assignment time (before the
 * agent's first wake fires) and reused across iterations.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "./schemas";

const AGENTS_DIR = process.env.AGENTS_DIR ?? "./agents";
const inFlight = new Map<string, Promise<string>>();

export function workDirFor(agent: string, taskId: string): string {
  return `${AGENTS_DIR}/${agent}/sandbox/work/${taskId}`;
}

async function validGitWorkTree(dir: string): Promise<boolean> {
  if (!existsSync(`${dir}/.git`)) return false;
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 && stdout.trim() === "true";
}

async function prepareWorkDirInner(agent: string, task: Task): Promise<string> {
  const dir = workDirFor(agent, task.id);
  if (await validGitWorkTree(dir)) return dir;

  await rm(dir, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });

  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await rm(tmp, { recursive: true, force: true });

  const proc = Bun.spawn(["git", "clone", task.repo, tmp], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`git clone failed for ${task.id} → ${dir}: ${err.trim()}`);
  }

  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  return dir;
}

/**
 * Clone task.repo into the agent's work dir if not already present.
 * Idempotent within a watcher process. Throws on git clone failure
 * (caller should surface the error rather than silently leave the agent
 * without a work tree).
 */
export async function prepareWorkDir(agent: string, task: Task): Promise<string> {
  const key = `${agent}\0${task.id}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = prepareWorkDirInner(agent, task).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
