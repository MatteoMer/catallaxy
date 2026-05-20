/**
 * Egress gateway container.
 *
 * To prevent agents from reaching the public internet via their bash
 * tool, the agent network (`catallaxy-agents`) is created with the
 * `--internal` flag — agents on it have NO route off the bridge,
 * including no route to the host. The orchestrator's proxy and RPC
 * are bound to the host's network namespace, so agents can't reach
 * them either by default.
 *
 * The gateway container fixes that. It is connected to TWO
 * networks:
 *   - catallaxy-agents (internal): so agents can dial it
 *   - bridge (default, has internet): so it can reach the host's
 *     proxy/RPC ports via host.docker.internal
 *
 * Inside the gateway, two `socat` processes forward
 *   :8443  →  host.docker.internal:8443  (egress proxy)
 *   :9443  →  host.docker.internal:9443  (RPC)
 *
 * Agents on the internal network reach the gateway via the
 * hostname `catallaxy-gateway`, which Docker's embedded DNS
 * resolves to its catallaxy-agents IP. The agent's pi config and
 * env therefore use `catallaxy-gateway` instead of
 * `host.docker.internal`. From the agent's view, only this single
 * peer is reachable on the network — direct connections elsewhere
 * time out for lack of a route; package-manager egress must use the
 * authenticated allowlisted proxy tunnel.
 *
 * The gateway runs as a long-lived container managed by the
 * watcher in secure/internal-network mode; reset.ts removes it.
 */

import { agentNetwork } from "./sandboxProfile";

const ROOT = process.cwd();
const GATEWAY_NAME = "catallaxy-gateway";
const GATEWAY_IMAGE = "alpine:3.20";
const RPC_PORT = parseInt(process.env.CATALLAXY_RPC_PORT ?? "9443", 10);
const PROXY_PORT = parseInt(process.env.CATALLAXY_PROXY_PORT ?? "8443", 10);
const DIRECT_SPAWN = process.env.BUN_SPAWN_AGENT_DIRECT === "1";

async function dockerOk(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

function spawnIgnore(args: string[]): void {
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  void proc.exited.catch(() => {});
}

async function waitForExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number, onTimeout: () => void): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<number>((resolve) => {
      timeout = setTimeout(() => {
        onTimeout();
        resolve(-1);
      }, timeoutMs);
    });
    return await Promise.race([proc.exited, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function containerExists(): Promise<boolean> {
  const proc = Bun.spawn(
    ["docker", "ps", "-a", "--filter", `name=^/${GATEWAY_NAME}$`, "--format", "{{.ID}}"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out.length > 0;
}

/**
 * Start the gateway container. Idempotent. Safe to call repeatedly:
 * if a stale gateway is running, we tear it down and re-create it
 * so its network attachments are guaranteed fresh for the current
 * watcher's network IDs.
 */
export async function startGateway(): Promise<void> {
  if (DIRECT_SPAWN || agentNetwork() !== "catallaxy-agents") return;
  if (await containerExists()) {
    await dockerOk(["rm", "-f", GATEWAY_NAME]);
  }

  // Forward both proxy and RPC ports. socat runs in foreground;
  // wrapping it in a shell with `&` + `wait` keeps the container
  // alive for both forwards.
  // `&` already ends the statement, so we use `\n` between forwards.
  const cmd = [
    `apk add --no-cache socat >/dev/null`,
    `socat TCP-LISTEN:${PROXY_PORT},fork,reuseaddr TCP:host.docker.internal:${PROXY_PORT} &`,
    `socat TCP-LISTEN:${RPC_PORT},fork,reuseaddr TCP:host.docker.internal:${RPC_PORT} &`,
    `wait`,
  ].join("\n");

  // First, attach to the default bridge so the gateway has internet
  // (needed to apk-add socat). We connect to catallaxy-agents in a
  // second step so its ordering is deterministic.
  const create = Bun.spawn([
    "docker", "run", "-d",
    "--name", GATEWAY_NAME,
    "--restart", "unless-stopped",
    "--add-host=host.docker.internal:host-gateway",
    "--network", "bridge",
    GATEWAY_IMAGE,
    "sh", "-c", cmd,
  ], { stdout: "pipe", stderr: "pipe" });
  const exit = await waitForExit(create, 30_000, () => {
    try { create.kill("SIGKILL"); } catch {}
    spawnIgnore(["pkill", "-KILL", "-f", `--name ${GATEWAY_NAME}`]);
    spawnIgnore(["docker", "rm", "-f", GATEWAY_NAME]);
  });
  if (exit !== 0) {
    const err = await new Response(create.stderr).text();
    throw new Error(`gateway create failed: ${err.trim()}`);
  }

  const connect = Bun.spawn(
    ["docker", "network", "connect", "catallaxy-agents", GATEWAY_NAME],
    { stdout: "ignore", stderr: "pipe" }
  );
  const cExit = await connect.exited;
  if (cExit !== 0) {
    const err = await new Response(connect.stderr).text();
    throw new Error(`gateway network attach failed: ${err.trim()}`);
  }

  // Wait until socat is actually listening — apk-add takes ~5-10s
  // on a cold image cache and an early agent wake would otherwise
  // ENOENT/ECONNREFUSED. Probe via `nc -z` from inside the gateway.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = Bun.spawn(
      ["docker", "exec", GATEWAY_NAME, "sh", "-c",
       `command -v socat >/dev/null && netstat -ltn 2>/dev/null | grep -q :${PROXY_PORT} && netstat -ltn 2>/dev/null | grep -q :${RPC_PORT}`],
      { stdout: "ignore", stderr: "ignore" }
    );
    if ((await probe.exited) === 0) {
      console.log(`[gateway] up — forwarding ${PROXY_PORT},${RPC_PORT} → host`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`gateway did not become ready within 30s`);
}

export async function stopGateway(): Promise<void> {
  if (DIRECT_SPAWN || agentNetwork() !== "catallaxy-agents") return;
  await dockerOk(["rm", "-f", GATEWAY_NAME]);
}

/** Hostname agents use to reach proxy/RPC. */
export const GATEWAY_HOSTNAME = GATEWAY_NAME;
