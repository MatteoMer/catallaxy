import { expect, test } from "bun:test";
import { isSafePlanningBash, isWriteTool } from "../.pi/extensions/catallaxy-interface/safety";

test("planning bash allows read-only inspection", () => {
  expect(isSafePlanningBash("pwd")).toBe(true);
  expect(isSafePlanningBash("ls -la")).toBe(true);
  expect(isSafePlanningBash("rg \"describe\" tests | head")).toBe(true);
  expect(isSafePlanningBash("git diff main...HEAD")).toBe(true);
  expect(isSafePlanningBash("sed -n '1,80p' package.json")).toBe(true);
});

test("planning bash blocks mutations before approval", () => {
  expect(isSafePlanningBash("mkdir -p tests")).toBe(false);
  expect(isSafePlanningBash("cat > tests/foo.test.ts")).toBe(false);
  expect(isSafePlanningBash("touch x")).toBe(false);
  expect(isSafePlanningBash("git checkout -b campaign/foo")).toBe(false);
  expect(isSafePlanningBash("bun install")).toBe(false);
});

test("write tools are classified as mutating", () => {
  expect(isWriteTool("write")).toBe(true);
  expect(isWriteTool("edit")).toBe(true);
  expect(isWriteTool("read")).toBe(false);
});
