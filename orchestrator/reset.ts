/**
 * reset — wipe all runtime state for a clean test run.
 *
 * Removes:
 *   - market/{tasks,bids,assignments,review_requests,review_responses}
 *   - agents/{name}/{memory,work,balance.json}
 *   - orchestrator/{ledger.json,private/}
 *   - playground branches other than main, untracked files inside the repo
 *
 * Preserves: code, SYSTEM.md, agents/{name}/identity.json, agent template.
 */

import { rm, readdir } from "node:fs/promises";

const ROOT = process.cwd();
const AGENTS_DIR = `${ROOT}/agents`;
const MARKET = `${ROOT}/market`;
const PLAYGROUND = `${ROOT}/repos/playground`;

async function rmrf(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function listAgents(): Promise<string[]> {
  try {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function git(args: string[]): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["git", "-C", PLAYGROUND, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

async function resetMarket(): Promise<void> {
  for (const dir of ["tasks", "bids", "assignments", "review_requests", "review_responses"]) {
    await rmrf(`${MARKET}/${dir}`);
  }
}

async function resetAgents(): Promise<void> {
  // Wipe everything in each sandbox except identity.json and the symlinks
  // (SYSTEM.md, market). Also wipe parent-level memory/, work/, balance.json
  // — these can exist if a stale (pre-sandbox-refactor) watcher is running
  // OR an agent navigated up and wrote there.
  const keepInSandbox = new Set(["identity.json", "SYSTEM.md", "market"]);
  for (const a of await listAgents()) {
    const agentDir = `${AGENTS_DIR}/${a}`;
    const sandbox = `${agentDir}/sandbox`;

    let entries: string[] = [];
    try {
      entries = await readdir(sandbox);
    } catch {}
    for (const e of entries) {
      if (!keepInSandbox.has(e)) await rmrf(`${sandbox}/${e}`);
    }

    for (const stale of ["balance.json", "memory", "work"]) {
      await rmrf(`${agentDir}/${stale}`);
    }
  }
}

async function resetOrchestrator(): Promise<void> {
  await rmrf(`${ROOT}/orchestrator/ledger.json`);
  await rmrf(`${ROOT}/orchestrator/private`);
}

async function resetPlayground(): Promise<void> {
  if ((await git(["rev-parse", "--git-dir"])).code !== 0) {
    console.log("  (no playground repo at repos/playground, skipping)");
    return;
  }
  await git(["checkout", "main"]);
  const { stdout } = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  const branches = stdout.split("\n").map((b) => b.trim()).filter((b) => b && b !== "main");
  for (const b of branches) {
    await git(["branch", "-D", b]);
  }
  await git(["reset", "--hard"]);
  await git(["clean", "-fd"]);
}

console.log("Resetting catallaxy state...");
await resetMarket();
console.log("  market/ wiped");
await resetAgents();
console.log("  agent runtime state wiped (memory, work, balance)");
await resetOrchestrator();
console.log("  ledger and reservations wiped");
await resetPlayground();
console.log("  playground reset to main");
console.log("Done.");
