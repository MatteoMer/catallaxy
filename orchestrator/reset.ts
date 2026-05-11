/**
 * reset — wipe all runtime state for a clean test run.
 *
 * Removes:
 *   - market/{tasks,bids,assignments,review_requests,review_responses}
 *   - agents/{name}/{memory,work,balance.json}
 *   - orchestrator/{ledger.json,private/} and .catallaxy/ (history, audit logs, campaign/reopen state)
 *   - running watcher/campaign/reopen processes and agent containers
 *   - playground branches other than main, untracked files inside the repo
 *
 * Preserves: code, SYSTEM.md, agents/{name}/identity.json, agent template.
 */

import { rm, readdir } from "node:fs/promises";

const ROOT = process.cwd();
const AGENTS_DIR = `${ROOT}/agents`;
const MARKET = `${ROOT}/market`;
const PLAYGROUND = `${ROOT}/repos/playground`;
const PLAYGROUND_INIT_REF = process.env.PLAYGROUND_RESET_REF ?? "2892fa2";

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
 * Kill any running orchestrator loops before wiping state. Otherwise their
 * in-memory state can get saved back to disk on the next tick and quietly
 * undo the reset.
 */
async function killRunningOrchestrators(): Promise<void> {
  const patterns = [
    "bun orchestrator/watch.ts",
    "bun orchestrator/watch-live.ts",
    "bun orchestrator/campaign.ts",
    "bun orchestrator/reopen.ts",
  ];
  const pids = new Set<number>();
  for (const pattern of patterns) {
    const proc = Bun.spawn(["pgrep", "-f", pattern], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of stdout.split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (Number.isInteger(pid) && pid !== process.pid) pids.add(pid);
    }
  }
  if (pids.size === 0) return;
  console.log(`  killing running orchestrator process(es): ${[...pids].join(", ")}`);
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
  await rmrf(`${ROOT}/.catallaxy`);
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
  // Reset to the playground's initial seed commit by default. Override with
  // PLAYGROUND_RESET_REF=<commit/tag> if a different baseline is needed.
  await git(["reset", "--hard", PLAYGROUND_INIT_REF]);
  await git(["clean", "-fd"]);
}

console.log("Resetting catallaxy state...");
await killRunningOrchestrators();
await resetMarket();
console.log("  market/ wiped");
await resetAgents();
console.log("  agent runtime state wiped (memory, work, balance)");
await resetOrchestrator();
console.log("  ledger and reservations wiped");
await resetDocker();
console.log("  agent containers + bridge network cleaned");
await resetPlayground();
console.log(`  playground reset to ${PLAYGROUND_INIT_REF}`);
console.log("Done.");
