import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnAgent reads AGENTS_DIR + reads files at module scope, so set
// env BEFORE the import.
const tmp = mkdtempSync(join(tmpdir(), "catallaxy-spawn-"));
const fakeDockerSocket = `${tmp}/docker.sock`;
writeFileSync(fakeDockerSocket, "");
process.env.AGENTS_DIR = `${tmp}/agents`;
process.env.BUN_SPAWN_AGENT_DIRECT = ""; // force container path
process.env.CATALLAXY_SANDBOX_PROFILE = "devserver";
process.env.CATALLAXY_ENABLE_DOCKER = "1";
process.env.CATALLAXY_DOCKER_SOCKET = fakeDockerSocket;
process.env.CATALLAXY_RPC_PORT = "9443";
process.env.CATALLAXY_PROXY_PORT = "8443";
delete process.env.AGENT_THINKING;

const { buildDockerArgs, buildPiArgs, effectiveAgentThinking } = await import("../orchestrator/spawnAgent");
const { buildReviewerPiArgs, buildReviewerDockerArgs } = await import("../orchestrator/spawnReviewer");

describe("spawnAgent argument construction", () => {
  const opts = {
    agent: "alice",
    prompt: "wake",
    model: "openrouter/test/model",
    authToken: "tok-aaaa-bbbb",
    runTag: "w42",
  };

  test("dev-server docker args keep base isolation but allow normal dev resources", () => {
    process.env.CATALLAXY_SANDBOX_PROFILE = "devserver";
    process.env.CATALLAXY_ENABLE_DOCKER = "1";
    const piArgs = buildPiArgs(opts);
    const args = buildDockerArgs(opts, piArgs);
    expect(args[0]).toBe("docker");
    expect(args[1]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("--init");
    expect(args).toContain("--user");
    expect(args).toContain("1000:1000");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).not.toContain("--read-only");
    expect(args).toContain("--memory=8g");
    expect(args).toContain("--cpus=4");
    expect(args).toContain("--shm-size=2g");
    expect(args).toContain("--pids-limit");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("4096");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
  });

  test("secure profile keeps the locked-down network and rootfs", () => {
    process.env.CATALLAXY_SANDBOX_PROFILE = "secure";
    process.env.CATALLAXY_ENABLE_DOCKER = "0";
    const args = buildDockerArgs(opts, buildPiArgs(opts));
    expect(args).toContain("--read-only");
    expect(args).toContain("--memory=2g");
    expect(args).toContain("--shm-size=512m");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("catallaxy-agents");
    process.env.CATALLAXY_SANDBOX_PROFILE = "devserver";
    process.env.CATALLAXY_ENABLE_DOCKER = "1";
  });

  test("docker args inject the auth token via env", () => {
    const args = buildDockerArgs(opts, buildPiArgs(opts));
    const envFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    expect(envFlags).toContain(`CATALLAXY_AUTH_TOKEN=${opts.authToken}`);
    expect(envFlags).toContain(`CATALLAXY_RPC_ADDR=host.docker.internal:9443`);
    // No leakage of host secret env vars.
    expect(envFlags.some((e) => e.startsWith("OPENROUTER_API_KEY="))).toBe(false);
    expect(envFlags.some((e) => e.startsWith("ANTHROPIC_API_KEY="))).toBe(false);
  });

  test("dev-server profile leaves broad egress direct; secure profile configures proxy egress", () => {
    process.env.CATALLAXY_SANDBOX_PROFILE = "devserver";
    let args = buildDockerArgs(opts, buildPiArgs(opts));
    let envFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    expect(envFlags.some((e) => e.startsWith("HTTPS_PROXY="))).toBe(false);
    expect(envFlags).toContain("NPM_CONFIG_CACHE=/sandbox/.cache/npm");

    process.env.CATALLAXY_SANDBOX_PROFILE = "secure";
    process.env.CATALLAXY_ENABLE_DOCKER = "0";
    args = buildDockerArgs(opts, buildPiArgs(opts));
    envFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    const proxy = `http://catallaxy:${opts.authToken}@catallaxy-gateway:8443`;
    expect(envFlags).toContain(`HTTPS_PROXY=${proxy}`);
    expect(envFlags).toContain(`NPM_CONFIG_HTTPS_PROXY=${proxy}`);
    expect(envFlags).toContain("NO_PROXY=catallaxy-gateway,localhost,127.0.0.1");
    expect(envFlags.some((e) => e.startsWith("HTTP_PROXY="))).toBe(false);
    process.env.CATALLAXY_SANDBOX_PROFILE = "devserver";
    process.env.CATALLAXY_ENABLE_DOCKER = "1";
  });

  test("dev-server docker args mount sandbox, pi-config, docker socket, and host-path mirror", () => {
    process.env.CATALLAXY_SANDBOX_PROFILE = "devserver";
    process.env.CATALLAXY_ENABLE_DOCKER = "1";
    const args = buildDockerArgs(opts, buildPiArgs(opts));
    const mounts = args.filter((_, i) => i > 0 && args[i - 1] === "-v");
    const sandbox = `${tmp}/agents/${opts.agent}/sandbox`;
    expect(mounts).toContain(`${sandbox}:/sandbox:rw`);
    expect(mounts).toContain(`${sandbox}:${sandbox}:rw`);
    expect(mounts).toContain(`${fakeDockerSocket}:/var/run/docker.sock`);
    expect(mounts.some((m) => m.endsWith(":/pi-config:ro"))).toBe(true);
    const envFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    expect(envFlags).toContain(`CATALLAXY_HOST_SANDBOX=${sandbox}`);
    expect(envFlags).toContain("DOCKER_HOST=unix:///var/run/docker.sock");
  });

  test("pi args pass auth token through --api-key (not the real upstream key)", () => {
    const piArgs = buildPiArgs(opts);
    const apiKeyIdx = piArgs.indexOf("--api-key");
    expect(apiKeyIdx).toBeGreaterThan(-1);
    expect(piArgs[apiKeyIdx + 1]).toBe(opts.authToken);
    expect(piArgs).toContain("--no-session");
    expect(piArgs).toContain("--mode");
  });

  test("agent pi args use medium thinking by default and allow AGENT_THINKING override", () => {
    let piArgs = buildPiArgs(opts);
    expect(piArgs).toContain("--thinking");
    expect(piArgs[piArgs.indexOf("--thinking") + 1]).toBe("medium");
    expect(effectiveAgentThinking(opts.model)).toBe("medium");

    process.env.AGENT_THINKING = "low";
    try {
      piArgs = buildPiArgs(opts);
      expect(piArgs[piArgs.indexOf("--thinking") + 1]).toBe("low");
      expect(effectiveAgentThinking(opts.model)).toBe("low");
    } finally {
      delete process.env.AGENT_THINKING;
    }
  });

  test("agent pi args preserve thinking suffixes in AGENT_MODEL", () => {
    const model = "openrouter/deepseek/deepseek-v4-flash:high";
    const piArgs = buildPiArgs({ ...opts, model });
    expect(piArgs).not.toContain("--thinking");
    expect(effectiveAgentThinking(model)).toBe("high");
  });

  test("pi args can restrict tool allowlist per wake", () => {
    const piArgs = buildPiArgs({ ...opts, tools: ["history", "place_bid"] });
    expect(piArgs).toContain("--tools");
    expect(piArgs[piArgs.indexOf("--tools") + 1]).toBe("history,place_bid");
  });

  test("container name encodes agent + run tag", () => {
    const args = buildDockerArgs(opts, buildPiArgs(opts));
    const nameIdx = args.indexOf("--name");
    expect(args[nameIdx + 1]).toBe("catallaxy-agent-alice-w42");
  });
});


describe("spawnReviewer argument construction", () => {
  const opts = {
    prompt: "review this",
    workDir: `${tmp}/work/task-001`,
    authToken: "tok-reviewer",
    runTag: "task-001-alice-1",
  };

  test("reviewer uses pi with Codex gpt-5.5 at medium thinking", () => {
    const args = buildReviewerPiArgs(opts);
    expect(args[0]).toBe("pi");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("openai-codex/gpt-5.5");
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("medium");
    expect(args).toContain("--no-session");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,grep,find,ls");
    expect(args).toContain("--no-context-files");
  });

  test("reviewer docker args keep work tree read-only and do not inject upstream keys", () => {
    const args = buildReviewerDockerArgs(opts, buildReviewerPiArgs(opts));
    expect(args).toContain("--read-only");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("catallaxy-agents");
    const mounts = args.filter((_, i) => i > 0 && args[i - 1] === "-v");
    expect(mounts).toContain(`${opts.workDir}:/work:ro`);
    const envFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    expect(envFlags).toContain(`CATALLAXY_AUTH_TOKEN=${opts.authToken}`);
    expect(envFlags.some((e) => e.startsWith("OPENROUTER_API_KEY="))).toBe(false);
    expect(envFlags.some((e) => e.startsWith("ANTHROPIC_API_KEY="))).toBe(false);
    expect(envFlags.some((e) => e.startsWith("OPENAI_API_KEY="))).toBe(false);
  });
});
