/**
 * Spawn `pi -p <prompt>` to review an agent's work.
 *
 * Reviewer model defaults to the same Codex provider/model family as this
 * operator instance:
 *   REVIEWER_MODEL=openai-codex/gpt-5.5
 *   REVIEWER_THINKING=medium
 *
 * Threat: the agent's repo contains untrusted code (configs, test scripts,
 * hooks). Pi may read/run commands during review (`git diff`, project tests).
 * In the default host path this is trusted and intentionally uses the
 * operator's local Codex/pi auth. Set CATALLAXY_REVIEWER_SANDBOX=on to run the
 * reviewer in a hardened container, but note that Codex auth must then be made
 * available to that container by the operator.
 */

import { existsSync } from "node:fs";

const ROOT = process.cwd();
const IMAGE = process.env.CATALLAXY_AGENT_IMAGE ?? "catallaxy-agent:latest";
const DIRECT_SPAWN = process.env.BUN_SPAWN_AGENT_DIRECT === "1";
const CUSTOM_SECCOMP_PATH = process.env.CATALLAXY_SECCOMP === "custom"
  ? `${ROOT}/docker/agent/seccomp.json`
  : null;
const HARDENING_DISABLED = process.env.CATALLAXY_DISABLE_HARDENING === "1";
const REVIEWER_SANDBOX = process.env.CATALLAXY_REVIEWER_SANDBOX === "on";

export const DEFAULT_REVIEWER_MODEL = "openai-codex/gpt-5.5";
export const DEFAULT_REVIEWER_THINKING = "medium";

export interface SpawnReviewerOpts {
  prompt: string;
  /** Host path to the work tree being reviewed. Mounted read-only in sandbox mode. */
  workDir: string;
  /** Reviewer's auth token (separate from agent tokens). */
  authToken: string;
  /** For container naming; e.g. task id + seq. */
  runTag: string;
  /** Wall-clock cap (seconds). Default 120. */
  timeoutSec?: number;
}

export function reviewerModel(): string {
  return process.env.REVIEWER_MODEL ?? DEFAULT_REVIEWER_MODEL;
}

export function reviewerThinking(): string {
  return process.env.REVIEWER_THINKING ?? DEFAULT_REVIEWER_THINKING;
}

export function buildReviewerPiArgs(opts: SpawnReviewerOpts): string[] {
  return [
    "pi",
    "-p", opts.prompt,
    "--model", reviewerModel(),
    "--thinking", reviewerThinking(),
    "--no-session",
    "--tools", "read,bash,grep,find,ls",
    // Do not let a task repo smuggle review instructions through AGENTS.md /
    // CLAUDE.md. The review prompt is the only authority.
    "--no-context-files",
  ];
}

export function buildReviewerDockerArgs(opts: SpawnReviewerOpts, piArgs: string[]): string[] {
  const timeout = opts.timeoutSec ?? 120;
  return [
    "docker", "run",
    "--rm", "-i",
    "--name", `catallaxy-reviewer-${opts.runTag}`,
    "--network", "catallaxy-agents",
    "--user", "1000:1000",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:size=100m",
    "--tmpfs", "/home/catallaxy:size=100m",
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
    "-e", `CATALLAXY_AUTH_TOKEN=${opts.authToken}`,
    "-w", "/work",
    IMAGE,
    "timeout", String(timeout),
    ...piArgs,
  ];
}

export function spawnReviewer(opts: SpawnReviewerOpts): ReturnType<typeof Bun.spawn> {
  const piArgs = buildReviewerPiArgs(opts);

  if (!REVIEWER_SANDBOX || DIRECT_SPAWN) {
    // Default path: pi runs on the host and uses the operator's existing
    // openai-codex/Codex auth, matching the current interactive instance.
    // Strip unrelated provider keys so accidental provider fallback does not
    // leak them into a reviewer subprocess.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENROUTER_API_KEY;
    return Bun.spawn(piArgs, {
      cwd: opts.workDir,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  }

  if (!existsSync(opts.workDir)) {
    throw new Error(`reviewer work dir missing: ${opts.workDir}`);
  }

  const args = buildReviewerDockerArgs(opts, piArgs);
  return Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    // Drop process.env entirely in sandbox mode; the container only sees -e
    // flags above. If the operator wants sandboxed Codex, provide auth through
    // an explicit future mechanism rather than leaking host env wholesale.
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
  });
}
