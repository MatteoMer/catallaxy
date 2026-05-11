import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";

test("catallaxy launcher starts quiet isolated pi session", async () => {
  const script = await readFile("bin/catallaxy", "utf-8");
  expect(script).toContain("USER_REPO=\"$(pwd)\"");
  expect(script).toContain("export CATALLAXY_INTERFACE=1");
  expect(script).toContain("export CATALLAXY_ROOT=\"$ROOT\"");
  expect(script).toContain("export CATALLAXY_USER_REPO=\"$USER_REPO\"");
  expect(script).toContain("export PI_OFFLINE=1");
  expect(script).toContain("export PI_SKIP_VERSION_CHECK=1");
  expect(script).toContain("export CATALLAXY_GALAXY_SEED");
  expect(script).toContain("unset TMUX");
  expect(script).toContain("(cd \"$ROOT\" && bun bin/catallaxy-splash.ts)");
  expect(script).toContain("--no-extensions");
  expect(script).toContain("-e \"$ROOT/.pi/extensions/catallaxy-interface/index.ts\"");
  expect(script).toContain("if [[ ${#args[@]} -gt 0 ]]");
});

test("project pi settings hide startup resource listing", async () => {
  const settings = await Bun.file(".pi/settings.json").json();
  expect(settings.quietStartup).toBe(true);
  expect(settings.enableInstallTelemetry).toBe(false);
  expect(settings.warnings.anthropicExtraUsage).toBe(false);
});
