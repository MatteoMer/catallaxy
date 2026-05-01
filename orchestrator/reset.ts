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

/**
 * Kill any running `bun orchestrator/watch.ts` processes before wiping
 * state. Otherwise their in-memory ledger gets saved back to disk on
 * the next tick and quietly undoes the reset.
 */
async function killRunningWatchers(): Promise<void> {
  const proc = Bun.spawn(["pgrep", "-f", "bun orchestrator/watch.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const pids = stdout
    .split("\n")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n !== process.pid);
  if (pids.length === 0) return;
  console.log(`  killing running watcher(s): ${pids.join(", ")}`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  await Bun.sleep(500);
}

async function resetMarket(): Promise<void> {
  for (const dir of ["tasks", "bids", "assignments", "review_requests", "review_responses", "pending_summaries"]) {
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

    for (const stale of ["balance.json", "memory", "work", ".pi-config"]) {
      await rmrf(`${agentDir}/${stale}`);
    }
  }
}

async function resetOrchestrator(): Promise<void> {
  await rmrf(`${ROOT}/orchestrator/ledger.json`);
  await rmrf(`${ROOT}/orchestrator/private`);
  // History was previously written into agents/{name}/sandbox/memory/history.md.
  // Stale copies could mislead agents; resetAgents() already wipes them but
  // we keep this comment as a breadcrumb for future archaeology.
}

/**
 * Best-effort cleanup of leftover agent containers and the bridge
 * network. A crashed watcher can leave per-wake containers dangling
 * (`--rm` only fires on graceful exit); the next watcher startup
 * would otherwise hit "name already in use" errors.
 */
async function resetDocker(): Promise<void> {
  const list = Bun.spawn(
    ["docker", "ps", "-a", "--filter", "name=catallaxy-agent-", "--filter", "name=catallaxy-gateway", "--format", "{{.ID}}"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const ids = (await new Response(list.stdout).text()).split("\n").map((s) => s.trim()).filter(Boolean);
  await list.exited;
  if (ids.length) {
    const rm = Bun.spawn(["docker", "rm", "-f", ...ids], { stdout: "ignore", stderr: "ignore" });
    await rm.exited;
    console.log(`  removed ${ids.length} leftover agent/gateway container(s)`);
  }
  const netRm = Bun.spawn(["docker", "network", "rm", "catallaxy-agents"], {
    stdout: "ignore", stderr: "ignore",
  });
  await netRm.exited;
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
await killRunningWatchers();
await resetMarket();
console.log("  market/ wiped");
await resetAgents();
console.log("  agent runtime state wiped (memory, work, balance)");
await resetOrchestrator();
console.log("  ledger and reservations wiped");
await resetDocker();
console.log("  agent containers + bridge network cleaned");
await resetPlayground();
console.log("  playground reset to main");
console.log("Done.");
