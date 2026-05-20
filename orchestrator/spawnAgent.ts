/**
 * Spawn a sandboxed `pi` process for an agent.
 *
 * By default the agent runs in the dev-server profile: still isolated to its
 * own /sandbox for persistent files, but otherwise usable as a normal dev box
 * (writable container overlay, larger memory/shm, broad network, and host
 * Docker socket when available). Set CATALLAXY_SANDBOX_PROFILE=secure for the
 * older locked-down runtime (read-only rootfs, internal network, proxied
 * package egress only).
 *
 * In both profiles, model traffic still goes through the host-side proxy via
 * generated /pi-config, so upstream API keys never enter the container.
 *
 * If `BUN_SPAWN_AGENT_DIRECT=1` is set, falls back to direct `pi`
 * spawn for local diagnostics (NOT for production — bypasses every
 * isolation guarantee). Useful for debugging inside CI before the
 * image is built.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { configDirFor } from "./proxy/agentConfig";
import {
  agentCpuLimit,
  agentMemoryLimit,
  agentNetwork,
  agentPidsLimit,
  agentShmSize,
  dockerAccessEnabled,
  dockerSocketPath,
  gatewayHost,
  isDevServerProfile,
  proxyPort,
  requireDockerSocket,
  rpcAddr,
  secureHomeTmpSize,
  secureTmpSize,
} from "./sandboxProfile";

const ROOT = process.cwd();
const AGENTS_DIR = process.env.AGENTS_DIR ? resolve(process.env.AGENTS_DIR) : `${ROOT}/agents`;
const IMAGE = process.env.CATALLAXY_AGENT_IMAGE ?? "catallaxy-agent:latest";
const DIRECT_SPAWN = process.env.BUN_SPAWN_AGENT_DIRECT === "1";
// Custom seccomp profile is opt-in. By default we rely on Docker's
// built-in profile, which is comprehensive and won't surprise-block
// syscalls Node/V8 needs (the custom profile is hard to keep
// up-to-date with every libc/runtime version).
const CUSTOM_SECCOMP_PATH = process.env.CATALLAXY_SECCOMP === "custom"
  ? `${ROOT}/docker/agent/seccomp.json`
  : null;
const HARDENING_DISABLED = process.env.CATALLAXY_DISABLE_HARDENING === "1";

export const DEFAULT_AGENT_THINKING = "medium";
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isThinkingLevel(level: string): boolean {
  return VALID_THINKING_LEVELS.has(level);
}

export function modelThinkingSuffix(model: string): string | undefined {
  const idx = model.lastIndexOf(":");
  if (idx < 0) return undefined;
  const suffix = model.slice(idx + 1);
  return isThinkingLevel(suffix) ? suffix : undefined;
}

export function agentThinking(): string {
  const level = process.env.AGENT_THINKING ?? DEFAULT_AGENT_THINKING;
  if (!isThinkingLevel(level)) {
    throw new Error(`invalid AGENT_THINKING=${JSON.stringify(level)}; expected one of ${[...VALID_THINKING_LEVELS].join(", ")}`);
  }
  return level;
}

export function effectiveAgentThinking(model: string): string {
  return modelThinkingSuffix(model) ?? agentThinking();
}

export interface SpawnOpts {
  agent: string;
  prompt: string;
  model: string;
  /** Optional comma allowlist of pi tools for this wake. */
  tools?: string[];
  /** This agent's auth token (validated by RPC + proxy on every call). */
  authToken: string;
  /** Tag suffix for the container name (e.g. wake counter / task id). */
  runTag: string;
}

function dockerSocketArgs(sandbox: string): string[] {
  if (!dockerAccessEnabled()) return [];

  const socket = dockerSocketPath();
  if (!existsSync(socket)) {
    if (requireDockerSocket()) throw new Error(`docker socket missing: ${socket}`);
    return [];
  }

  const args: string[] = [];
  try {
    const gid = statSync(socket).gid;
    if (Number.isInteger(gid)) args.push("--group-add", String(gid));
  } catch {}

  args.push(
    "-v", `${socket}:/var/run/docker.sock`,
    // Docker-outside-of-Docker path fix: docker compose running from /sandbox
    // would otherwise send /sandbox/... bind mounts to the host daemon, where
    // that path does not exist. The image's docker wrapper cd/re-writes to this
    // mirrored host path before invoking the real Docker CLI.
    "-v", `${sandbox}:${sandbox}:rw`,
    "-e", "DOCKER_HOST=unix:///var/run/docker.sock",
    "-e", `CATALLAXY_HOST_SANDBOX=${sandbox}`,
    "-e", "CATALLAXY_CONTAINER_SANDBOX=/sandbox",
  );
  return args;
}

function packageProxy(authToken: string): string {
  return `http://catallaxy:${authToken}@${gatewayHost()}:${proxyPort()}`;
}

function devHost(): string {
  const network = agentNetwork();
  if (network === "host") return "127.0.0.1";
  if (network === "catallaxy-agents") return "catallaxy-gateway";
  return "host.docker.internal";
}

/**
 * Build the `docker run` argv for an agent. Keeps the call sites in
 * watch.ts and pretrain.ts identical. The pi command is appended at
 * the end as the image's entrypoint args.
 */
export function buildDockerArgs(opts: SpawnOpts, piArgs: string[]): string[] {
  const sandbox = `${AGENTS_DIR}/${opts.agent}/sandbox`;
  const piConfig = configDirFor(opts.agent);
  const devServer = isDevServerProfile();
  const network = agentNetwork();
  const pkgProxy = packageProxy(opts.authToken);
  const home = devServer ? "/sandbox" : "/home/catallaxy";

  const args: string[] = [
    "docker", "run",
    "--rm", "-i",
    "--name", `catallaxy-agent-${opts.agent}-${opts.runTag}`,
    "--network", network,
    "--init",
    "--user", "1000:1000",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    ...(devServer ? [] : [
      "--read-only",
      "--tmpfs", `/tmp:size=${secureTmpSize()}`,
      "--tmpfs", `/home/catallaxy:size=${secureHomeTmpSize()}`,
    ]),
    `--memory=${agentMemoryLimit()}`,
    `--cpus=${agentCpuLimit()}`,
    "--pids-limit", agentPidsLimit(),
    `--shm-size=${agentShmSize()}`,
    "--ulimit", "nofile=1048576:1048576",
    ...(network === "host" ? [] : ["--add-host=host.docker.internal:host-gateway"]),
    ...(HARDENING_DISABLED || !CUSTOM_SECCOMP_PATH || !existsSync(CUSTOM_SECCOMP_PATH)
      ? []
      : ["--security-opt", `seccomp=${CUSTOM_SECCOMP_PATH}`]),
    ...(HARDENING_DISABLED ? [] : ["--security-opt", "apparmor=docker-default"]),
    "-v", `${sandbox}:/sandbox:rw`,
    ...dockerSocketArgs(sandbox),
    // Read-only config dir contains models.json (proxy URL),
    // auth.json (empty), settings.json (empty) — written by the
    // orchestrator at startup. Pi sees the dir as PI_CODING_AGENT_DIR
    // and reads the proxy override from models.json. Because the
    // mount is :ro the agent cannot rewrite its own routing.
    "-v", `${piConfig}:/pi-config:ro`,
    "-e", "PI_CODING_AGENT_DIR=/pi-config",
    "-e", `HOME=${home}`,
    "-e", `CATALLAXY_RPC_ADDR=${rpcAddr()}`,
    "-e", `CATALLAXY_AUTH_TOKEN=${opts.authToken}`,
    "-e", `CATALLAXY_DEV_HOST=${devHost()}`,
    ...(devServer ? [] : [
      // Package-manager HTTPS egress (npm/pnpm/yarn/bun, plus any
      // allowlisted HTTPS fetches) goes through the authenticated proxy in
      // secure mode. Dev-server mode intentionally leaves broad egress alone.
      "-e", `HTTPS_PROXY=${pkgProxy}`,
      "-e", `https_proxy=${pkgProxy}`,
      "-e", `NPM_CONFIG_HTTPS_PROXY=${pkgProxy}`,
      "-e", `npm_config_https_proxy=${pkgProxy}`,
      "-e", `NO_PROXY=${gatewayHost()},localhost,127.0.0.1`,
      "-e", `no_proxy=${gatewayHost()},localhost,127.0.0.1`,
    ]),
    // Keep package-manager caches in the persistent sandbox. This avoids
    // read-only-root issues in secure mode and speeds repeated dev runs.
    "-e", "NPM_CONFIG_CACHE=/sandbox/.cache/npm",
    "-e", "npm_config_cache=/sandbox/.cache/npm",
    "-e", "YARN_CACHE_FOLDER=/sandbox/.cache/yarn",
    "-e", "BUN_INSTALL_CACHE_DIR=/sandbox/.cache/bun",
    "-w", "/sandbox",
    IMAGE,
    ...piArgs,
  ];

  return args;
}

/**
 * Build the pi invocation that is identical regardless of host vs
 * container: pi reads the prompt from `-p`, talks to its provider via
 * the proxy, and loads the catallaxy extension from the bundled
 * /catallaxy/extensions/ path inside the container (or from the host
 * source tree in direct mode).
 */
export function buildPiArgs(opts: SpawnOpts): string[] {
  const extensionPath = DIRECT_SPAWN
    ? `${ROOT}/extensions/catallaxy.ts`
    : "/catallaxy/extensions/catallaxy.ts";

  // Pi's --api-key is set to the agent's catallaxy auth token; pi
  // forwards it as `Authorization: Bearer <token>` to the proxy
  // baseUrl. The proxy validates the token, identifies this agent,
  // strips the header, and injects the real OpenRouter key. The
  // container never sees the real upstream key.
  const args = [
    "pi",
    "-p", opts.prompt,
    "--model", opts.model,
  ];
  if (!modelThinkingSuffix(opts.model)) {
    args.push("--thinking", agentThinking());
  }
  args.push(
    "--api-key", opts.authToken,
    "--mode", "json",
    "--no-session",
    "-e", extensionPath,
  );
  if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
  return args;
}

/**
 * Spawn the agent and return Bun's subprocess handle. Caller drains
 * stdout / stderr exactly as before.
 */
export function spawnAgent(opts: SpawnOpts): ReturnType<typeof Bun.spawn> {
  const piArgs = buildPiArgs(opts);

  if (DIRECT_SPAWN) {
    return Bun.spawn(piArgs, {
      cwd: `${AGENTS_DIR}/${opts.agent}/sandbox`,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: configDirFor(opts.agent),
        CATALLAXY_RPC_ADDR: `127.0.0.1:9443`,
        CATALLAXY_AUTH_TOKEN: opts.authToken,
      },
    });
  }

  // Sanity check: the bind-mount source must exist or docker errors
  // out with a confusing "no such file or directory" referring to a
  // host path it cannot inspect from the engine's mount namespace.
  const sandbox = `${AGENTS_DIR}/${opts.agent}/sandbox`;
  if (!existsSync(sandbox)) {
    throw new Error(`agent sandbox missing: ${sandbox}`);
  }
  if (isDevServerProfile()) {
    mkdirSync(`${sandbox}/.cache`, { recursive: true });
  }
  const piConfig = configDirFor(opts.agent);
  if (!existsSync(`${piConfig}/models.json`)) {
    throw new Error(`agent pi-config missing: ${piConfig}/models.json`);
  }

  const args = buildDockerArgs(opts, piArgs);
  return Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    // Drop process.env entirely — the container's only env is what
    // -e flags above set. ANTHROPIC_API_KEY and OPENROUTER_API_KEY
    // are absent inside.
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    },
  });
}

/**
 * Idempotently create the catallaxy-agents bridge.
 *
 * `--internal` strips the network of all external connectivity:
 * agents on it have no route to the public internet AND no route to
 * the host. The gateway container (orchestrator/gateway.ts) bridges
 * agent-side traffic to the host's proxy/RPC ports, so the only
 * things an agent can reach are gateway:8443 (model proxy plus
 * allowlisted package-manager CONNECT) and gateway:9443 (RPC). The
 * agent's bash tool can curl arbitrary hosts all day; unless the
 * process uses the authenticated proxy and the target host is
 * allowlisted, the packet has nowhere to go.
 *
 * ICC stays on (Docker default) because the gateway lives on this
 * same network — turning ICC off would block agent → gateway too,
 * not just agent ↔ agent. Agent processes don't open listening
 * sockets, and auth tokens are 32-byte secrets known only to the
 * orchestrator and one container, so peer-side brute force or
 * impersonation is not practical.
 */
export async function ensureAgentNetwork(): Promise<void> {
  if (DIRECT_SPAWN || agentNetwork() !== "catallaxy-agents") return;
  const inspect = Bun.spawn(
    ["docker", "network", "inspect", "catallaxy-agents", "--format", "{{.Internal}}"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const inspected = (await new Response(inspect.stdout).text()).trim();
  await inspect.exited;
  if (inspected === "true") return;

  // Re-create with --internal. `network rm` fails if anything's
  // still attached; in steady state nothing is.
  await Bun.spawn(["docker", "network", "rm", "catallaxy-agents"], {
    stdout: "ignore", stderr: "ignore",
  }).exited;
  const create = Bun.spawn([
    "docker", "network", "create",
    "--driver", "bridge",
    "--internal",
    "catallaxy-agents",
  ], { stdout: "ignore", stderr: "pipe" });
  const exit = await create.exited;
  if (exit !== 0) {
    const err = await new Response(create.stderr).text();
    throw new Error(`could not create catallaxy-agents network: ${err.trim()}`);
  }
}
