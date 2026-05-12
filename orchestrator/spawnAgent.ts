/**
 * Spawn a sandboxed `pi` process for an agent.
 *
 * The agent runs as uid 1000 inside an unprivileged container with:
 *   - all caps dropped, no-new-privileges, seccomp + apparmor
 *   - read-only root filesystem (tmpfs for /tmp and /home)
 *   - cpu/memory/pid limits
 *   - bind-mounted /sandbox (rw) — the agent's only writable host path
 *   - CATALLAXY_RPC_ADDR points at the gateway-forwarded RPC server
 *   - bind-mounted /pi-config (ro) — pi's models.json points the
 *     openrouter provider at the host-side egress proxy, so model
 *     traffic flows through key injection. Package-manager HTTPS egress
 *     uses the same proxy as an authenticated allowlisted CONNECT tunnel.
 *     The container never sees real upstream API keys.
 *
 * If `BUN_SPAWN_AGENT_DIRECT=1` is set, falls back to direct `pi`
 * spawn for local diagnostics (NOT for production — bypasses every
 * isolation guarantee). Useful for debugging inside CI before the
 * image is built.
 */

import { existsSync } from "node:fs";
import { configDirFor } from "./proxy/agentConfig";

const ROOT = process.cwd();
const AGENTS_DIR = process.env.AGENTS_DIR ?? `${ROOT}/agents`;
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

/**
 * Build the `docker run` argv for an agent. Keeps the call sites in
 * watch.ts and pretrain.ts identical. The pi command is appended at
 * the end as the image's entrypoint args.
 */
export function buildDockerArgs(opts: SpawnOpts, piArgs: string[]): string[] {
  const sandbox = `${AGENTS_DIR}/${opts.agent}/sandbox`;
  const piConfig = configDirFor(opts.agent);
  const packageProxy = `http://catallaxy:${opts.authToken}@catallaxy-gateway:8443`;

  const args: string[] = [
    "docker", "run",
    "--rm", "-i",
    "--name", `catallaxy-agent-${opts.agent}-${opts.runTag}`,
    "--network", "catallaxy-agents",
    "--user", "1000:1000",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:size=100m",
    "--tmpfs", "/home/catallaxy:size=20m",
    "--memory=2g",
    "--cpus=1",
    // Node + V8 + libuv worker pool + pi extension threads can
    // easily push past 128. 512 is comfortable for a single agent
    // wake while still cutting off any fork-bomb behavior.
    "--pids-limit=512",
    "--add-host=host.docker.internal:host-gateway",
    ...(HARDENING_DISABLED || !CUSTOM_SECCOMP_PATH || !existsSync(CUSTOM_SECCOMP_PATH)
      ? []
      : ["--security-opt", `seccomp=${CUSTOM_SECCOMP_PATH}`]),
    ...(HARDENING_DISABLED ? [] : ["--security-opt", "apparmor=docker-default"]),
    "-v", `${sandbox}:/sandbox:rw`,
    // Read-only config dir contains models.json (proxy URL),
    // auth.json (empty), settings.json (empty) — written by the
    // orchestrator at startup. Pi sees the dir as PI_CODING_AGENT_DIR
    // and reads the proxy override from models.json. Because the
    // mount is :ro the agent cannot rewrite its own routing.
    "-v", `${piConfig}:/pi-config:ro`,
    "-e", "PI_CODING_AGENT_DIR=/pi-config",
    "-e", "HOME=/home/catallaxy",
    // The agent network is --internal; the only host the agent can
    // reach is the gateway, which forwards :8443/:9443 to the host's
    // proxy/RPC. Identity is established by the auth token (env)
    // which the gateway forwards verbatim.
    "-e", `CATALLAXY_RPC_ADDR=catallaxy-gateway:9443`,
    "-e", `CATALLAXY_AUTH_TOKEN=${opts.authToken}`,
    // Package-manager HTTPS egress (npm/pnpm/yarn/bun, plus any
    // allowlisted HTTPS fetches) goes through the same authenticated
    // proxy. Only HTTPS proxy vars are set so pi's plain-http model
    // baseUrl is not accidentally re-proxied through itself.
    "-e", `HTTPS_PROXY=${packageProxy}`,
    "-e", `https_proxy=${packageProxy}`,
    "-e", `NPM_CONFIG_HTTPS_PROXY=${packageProxy}`,
    "-e", `npm_config_https_proxy=${packageProxy}`,
    "-e", "NO_PROXY=catallaxy-gateway,localhost,127.0.0.1",
    "-e", "no_proxy=catallaxy-gateway,localhost,127.0.0.1",
    // Keep package-manager caches off the read-only root and out of
    // the small HOME tmpfs. Persisting per-agent caches also makes
    // repeated installs cheaper.
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
    "--api-key", opts.authToken,
    "--mode", "json",
    "--no-session",
    "-e", extensionPath,
  ];
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
  if (DIRECT_SPAWN) return;
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
