import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = process.cwd();
const PRIVATE = `${ROOT}/orchestrator/private`;
const PID_PATH = `${PRIVATE}/watch.pid`;
const LOG_PATH = `${PRIVATE}/watch.log`;
const RESTART_DELAY_MS = Number(process.env.WATCH_RESTART_DELAY_MS ?? "2000");

let stopping = false;
let child: Bun.Subprocess | undefined;

async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(PID_PATH, "utf-8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function appendLog(line: string): Promise<void> {
  await appendFile(LOG_PATH, line.endsWith("\n") ? line : `${line}\n`);
}

async function attach(pid: number): Promise<void> {
  console.log(`Catallaxy watcher already running (pid ${pid}); attaching to ${LOG_PATH}`);
  if (!existsSync(LOG_PATH)) await writeFile(LOG_PATH, "");
  const tail = Bun.spawn(["tail", "-n", "200", "-f", LOG_PATH], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => {
    try { tail.kill("SIGTERM"); } catch {}
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await tail.exited;
}

async function pump(stream: ReadableStream<Uint8Array>, target: "stdout" | "stderr"): Promise<void> {
  const writer = target === "stdout" ? process.stdout : process.stderr;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    writer.write(chunk);
    await appendFile(LOG_PATH, chunk);
  }
}

async function cleanupContainers(): Promise<void> {
  const list = Bun.spawn(
    ["docker", "ps", "-a", "--filter", "name=catallaxy-agent-", "--filter", "name=catallaxy-gateway", "--format", "{{.ID}}"],
    { stdout: "pipe", stderr: "ignore" }
  );
  const ids = (await new Response(list.stdout).text()).split("\n").map((s) => s.trim()).filter(Boolean);
  await list.exited;
  if (ids.length === 0) return;
  const rmProc = Bun.spawn(["docker", "rm", "-f", ...ids], { stdout: "ignore", stderr: "ignore" });
  await rmProc.exited;
  await appendLog(`--- watcher supervisor removed ${ids.length} stale container(s) ---`);
}

async function runChildOnce(): Promise<number> {
  await writeFile(LOG_PATH, `\n--- watcher start ${new Date().toISOString()} ---\n`, { flag: "a" });

  child = Bun.spawn(["bun", "orchestrator/watch.ts"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
  });
  await writeFile(PID_PATH, String(child.pid));
  console.log(`Catallaxy watcher started (pid ${child.pid}); logging to ${LOG_PATH}`);

  const codePromise = child.exited;
  await Promise.all([
    pump(child.stdout as ReadableStream<Uint8Array>, "stdout"),
    pump(child.stderr as ReadableStream<Uint8Array>, "stderr"),
  ]);
  const code = await codePromise;
  const current = await readPid();
  if (current === child.pid) await rm(PID_PATH, { force: true });
  child = undefined;
  return code;
}

async function supervise(): Promise<void> {
  await mkdir(PRIVATE, { recursive: true });
  while (!stopping) {
    const code = await runChildOnce();
    if (stopping || code === 0) {
      process.exitCode = code;
      return;
    }

    const marker = `--- watcher crashed/exited code ${code} at ${new Date().toISOString()}; restarting in ${RESTART_DELAY_MS}ms ---`;
    console.error(marker);
    await appendLog(marker);
    await cleanupContainers();
    await Bun.sleep(RESTART_DELAY_MS);
  }
}

const stop = () => {
  stopping = true;
  try { child?.kill("SIGTERM"); } catch {}
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await mkdir(PRIVATE, { recursive: true });
const pid = await readPid();
if (pid && isAlive(pid)) await attach(pid);
else {
  if (pid) await rm(PID_PATH, { force: true });
  await supervise();
}
