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

  test("container name encodes agent + run tag", () => {
    const args = buildDockerArgs(opts, buildPiArgs(opts));
    const nameIdx = args.indexOf("--name");
    expect(args[nameIdx + 1]).toBe("catallaxy-agent-alice-w42");
  });
});
