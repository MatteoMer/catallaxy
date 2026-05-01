/**
 * Spawn `claude -p <prompt>` inside an isolated container to review
 * an agent's work.
 *
 * Threat: the agent's repo contains untrusted code (configs, test
 * scripts, hooks). Claude reads/runs commands during review (`git
 * diff`, project tests). On the host, that runs with the watcher's
 * uid, env, and home — including ANTHROPIC_API_KEY and any other
 * secrets. Container isolation contains a malicious config script
 * to a uid-1000, no-cap, no-host-net, no-internet container with a
 * read-only mount of just the work tree and a 90-second wall-clock
 * cap.
 *
 * Network: same `catallaxy-agents` --internal bridge as agents. The
 * only thing the container can reach is `catallaxy-gateway`, which
 * forwards to the host's egress proxy. Claude is configured via
 * ANTHROPIC_BASE_URL to use that proxy; the proxy injects the real
 * Anthropic key host-side. Claude in the container only ever sees
 * the dummy key it was given.
 */

import { existsSync } from "node:fs";

const ROOT = process.cwd();
const IMAGE = process.env.CATALLAXY_AGENT_IMAGE ?? "catallaxy-agent:latest";
const DIRECT_SPAWN = process.env.BUN_SPAWN_AGENT_DIRECT === "1";
const CUSTOM_SECCOMP_PATH = process.env.CATALLAXY_SECCOMP === "custom"
  ? `${ROOT}/docker/agent/seccomp.json`
  : null;
const HARDENING_DISABLED = process.env.CATALLAXY_DISABLE_HARDENING === "1";
// Off by default until the operator has an Anthropic API key the
// proxy can inject. The host-side claude path still runs the same
// command with ANTHROPIC_API_KEY stripped, so claude falls back to
// whatever auth the user already has (typically Claude Pro OAuth in
// the macOS keychain). Set CATALLAXY_REVIEWER_SANDBOX=on to opt in.
const REVIEWER_SANDBOX = process.env.CATALLAXY_REVIEWER_SANDBOX === "on";

export interface SpawnReviewerOpts {
  prompt: string;
  /** Host path to the work tree being reviewed. Mounted read-only. */
  workDir: string;
  /** Reviewer's auth token (separate from agent tokens). */
  authToken: string;
  /** For container naming; e.g. task id + seq. */
  runTag: string;
  /** Wall-clock cap (seconds). Default 120. */
  timeoutSec?: number;
}

export function spawnReviewer(opts: SpawnReviewerOpts): ReturnType<typeof Bun.spawn> {
  if (!REVIEWER_SANDBOX || DIRECT_SPAWN) {
    // Legacy path: claude runs on the host. ANTHROPIC_API_KEY is
    // stripped so claude falls back to whatever auth the operator
    // has configured (typically Claude Pro OAuth in macOS keychain).
    // The reviewer is trusted in this mode — agent code in the work
    // tree could be executed by claude with the watcher's host
    // privileges. Set CATALLAXY_REVIEWER_SANDBOX=on once an
    // injectable API key is available to lock this down.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    return Bun.spawn(["claude", "-p", opts.prompt], {
      cwd: opts.workDir,
      stdout: "pipe", stderr: "pipe",
      env,
    });
  }

  if (!existsSync(opts.workDir)) {
    throw new Error(`reviewer work dir missing: ${opts.workDir}`);
  }

  const timeout = opts.timeoutSec ?? 120;
  const args: string[] = [
    "docker", "run",
    "--rm", "-i",
    "--name", `catallaxy-reviewer-${opts.runTag}`,
    "--network", "catallaxy-agents",
    "--user", "1000:1000",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:size=100m",
    "--tmpfs", "/home/catallaxy:size=20m",
    "--memory=2g",
    "--cpus=1",
    "--pids-limit=512",
    "--stop-timeout", String(timeout),
    ...(HARDENING_DISABLED || !CUSTOM_SECCOMP_PATH || !existsSync(CUSTOM_SECCOMP_PATH)
      ? []
      : ["--security-opt", `seccomp=${CUSTOM_SECCOMP_PATH}`]),
    ...(HARDENING_DISABLED ? [] : ["--security-opt", "apparmor=docker-default"]),
    "-v", `${opts.workDir}:/work:ro`,
    "-e", "HOME=/home/catallaxy",
    "-e", `ANTHROPIC_BASE_URL=http://catallaxy-gateway:8443/anthropic`,
    "-e", `ANTHROPIC_API_KEY=${DUMMY_API_KEY}`,
    "-e", `CATALLAXY_AUTH_TOKEN=${opts.authToken}`,
    "-w", "/work",
    IMAGE,
    "timeout", String(timeout),
    "claude", "-p", opts.prompt,
  ];

  return Bun.spawn(args, {
    stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
  });
}
