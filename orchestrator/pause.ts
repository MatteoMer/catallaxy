import { rm } from "node:fs/promises";

const ROOT = process.cwd();
const PRIVATE = `${ROOT}/orchestrator/private`;

const PID_FILES = [
  `${PRIVATE}/watch.pid`,
  `${PRIVATE}/watch-live.pid`,
  `${PRIVATE}/campaign.pid`,
  `${PRIVATE}/reopen.pid`,
];

export const ORCHESTRATOR_PATTERNS = [
  "bun orchestrator/watch.ts",
  "bun orchestrator/watch-live.ts",
  "bun orchestrator/campaign.ts",
  "bun orchestrator/reopen.ts",
] as const;

const STALE_DOCKER_RUN_PATTERNS = [
  "docker run --rm -i --name catallaxy-agent-",
  "com.docker.cli run --rm -i --name catallaxy-agent-",
  "docker run -d --name catallaxy-gateway",
  "com.docker.cli run -d --name catallaxy-gateway",
] as const;

export function parsePidList(stdout: string, selfPid = process.pid): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== selfPid) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findPids(patterns: readonly string[]): Promise<number[]> {
  const pids = new Set<number>();
  for (const pattern of patterns) {
    const proc = Bun.spawn(["pgrep", "-f", pattern], { stdout: "pipe", stderr: "ignore" });
    const found = parsePidList(await new Response(proc.stdout).text());
    await proc.exited;
    for (const pid of found) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}

async function stopPids(pids: number[]): Promise<void> {
  if (!pids.length) {
    console.log("  no running orchestrator processes found");
    return;
  }

  console.log(`  stopping orchestrator process(es): ${pids.join(", ")}`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }

  await Bun.sleep(1000);
  const survivors = pids.filter(isAlive);
  if (!survivors.length) return;

  console.log(`  force-killing stubborn process(es): ${survivors.join(", ")}`);
  for (const pid of survivors) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  await Bun.sleep(250);
}

async function stopStaleDockerRuns(): Promise<void> {
  const pids = await findPids(STALE_DOCKER_RUN_PATTERNS);
  if (!pids.length) return;
  console.log(`  stopping stale agent docker-run process(es): ${pids.join(", ")}`);
  await stopPids(pids);
}

async function removePidFiles(): Promise<void> {
  await Promise.all(PID_FILES.map((path) => rm(path, { force: true })));
}

async function stopContainers(): Promise<void> {
  const list = Bun.spawn(
    ["docker", "ps", "-a", "--filter", "name=catallaxy-agent-", "--filter", "name=catallaxy-gateway", "--format", "{{.ID}}"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const ids = (await new Response(list.stdout).text()).split("\n").map((s) => s.trim()).filter(Boolean);
  await list.exited;

  if (!ids.length) {
    console.log("  no agent/gateway containers found");
    return;
  }

  const rmProc = Bun.spawn(["docker", "rm", "-f", ...ids], { stdout: "ignore", stderr: "ignore" });
  await rmProc.exited;
  console.log(`  removed ${ids.length} agent/gateway container(s)`);
}

export async function pause(): Promise<void> {
  console.log("Pausing catallaxy runtime...");
  const pids = await findPids(ORCHESTRATOR_PATTERNS);
  await stopPids(pids);
  await stopStaleDockerRuns();
  await removePidFiles();
  await stopContainers();
  console.log("Paused. Market, ledger, repo, and agent memory state preserved.");
}

if (import.meta.main) {
  pause().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
