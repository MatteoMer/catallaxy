import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnAgent reads AGENTS_DIR + reads files at module scope, so set
// env BEFORE the import.
const tmp = mkdtempSync(join(tmpdir(), "catallaxy-spawn-"));
process.env.AGENTS_DIR = `${tmp}/agents`;
process.env.BUN_SPAWN_AGENT_DIRECT = ""; // force container path

const { buildDockerArgs, buildPiArgs } = await import("../orchestrator/spawnAgent");
const { buildReviewerPiArgs, buildReviewerDockerArgs } = await import("../orchestrator/spawnReviewer");

describe("spawnAgent argument construction", () => {
  const opts = {
    agent: "alice",
    prompt: "wake",
    model: "openrouter/test/model",
    authToken: "tok-aaaa-bbbb",
    runTag: "w42",
  };

  test("docker args carry every required hardening flag", () => {
    const piArgs = buildPiArgs(opts);
    const args = buildDockerArgs(opts, piArgs);
    expect(args[0]).toBe("docker");
    expect(args[1]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("--user");
    expect(args).toContain("1000:1000");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args).toContain("--memory=2g");
    expect(args).toContain("--pids-limit=512");
    // Network must be the locked-down one — never `bridge` or `host`.
    expect(args).toContain("--network");
    const netIdx = args.indexOf("--network");
    expect(args[netIdx + 1]).toBe("catallaxy-agents");
  });

  test("docker args inject the auth token via env", () => {
    const args = buildDockerArgs(opts, buildPiArgs(opts));
    const envFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    expect(envFlags).toContain(`CATALLAXY_AUTH_TOKEN=${opts.authToken}`);
    expect(envFlags).toContain(`CATALLAXY_RPC_ADDR=catallaxy-gateway:9443`);
    // No leakage of host secret env vars.
    expect(envFlags.some((e) => e.startsWith("OPENROUTER_API_KEY="))).toBe(false);
    expect(envFlags.some((e) => e.startsWith("ANTHROPIC_API_KEY="))).toBe(false);
  });

  test("docker args configure authenticated package-manager egress", () => {
    const args = buildDockerArgs(opts, buildPiArgs(opts));
    const envFlags = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    const proxy = `http://catallaxy:${opts.authToken}@catallaxy-gateway:8443`;
    expect(envFlags).toContain(`HTTPS_PROXY=${proxy}`);
    expect(envFlags).toContain(`NPM_CONFIG_HTTPS_PROXY=${proxy}`);
    expect(envFlags).toContain("NO_PROXY=catallaxy-gateway,localhost,127.0.0.1");
    expect(envFlags).toContain("NPM_CONFIG_CACHE=/sandbox/.cache/npm");
    // Do not set HTTP_PROXY: pi's model baseUrl is plain HTTP to the gateway.
    expect(envFlags.some((e) => e.startsWith("HTTP_PROXY="))).toBe(false);
  });

  test("docker args mount sandbox rw, pi-config ro", () => {
    const args = buildDockerArgs(opts, buildPiArgs(opts));
    const mounts = args.filter((_, i) => i > 0 && args[i - 1] === "-v");
    expect(mounts.some((m) => m.endsWith(":/sandbox:rw"))).toBe(true);
    expect(mounts.some((m) => m.endsWith(":/pi-config:ro"))).toBe(true);
    // Should NOT mount any other host paths into the container.
    for (const m of mounts) {
      const target = m.split(":")[1];
      expect(["/sandbox", "/pi-config"]).toContain(target);
    }
  });

  test("pi args pass auth token through --api-key (not the real upstream key)", () => {
    const piArgs = buildPiArgs(opts);
    const apiKeyIdx = piArgs.indexOf("--api-key");
    expect(apiKeyIdx).toBeGreaterThan(-1);
    expect(piArgs[apiKeyIdx + 1]).toBe(opts.authToken);
    expect(piArgs).toContain("--no-session");
    expect(piArgs).toContain("--mode");
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
