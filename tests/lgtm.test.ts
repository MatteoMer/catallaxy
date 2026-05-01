import { describe, expect, test } from "bun:test";
import { isLgtm } from "../orchestrator/lgtm";

describe("isLgtm", () => {
  test("plain LGTM", () => {
    expect(isLgtm("LGTM")).toBe(true);
    expect(isLgtm("lgtm")).toBe(true);
    expect(isLgtm("  LGTM  ")).toBe(true);
    expect(isLgtm("LGTM.")).toBe(true);
  });

  test("LGTM as last line of a longer response", () => {
    expect(isLgtm("All 10 tests pass. Implementation correctly uses Kahn's algorithm without mutating input.\n\nLGTM")).toBe(true);
    expect(isLgtm("Looks good. The diff is clean.\n\nLGTM!")).toBe(true);
  });

  test("LGTM as first line, with extra commentary after", () => {
    expect(isLgtm("LGTM\n\nNice work.")).toBe(true);
  });

  test("hedged approvals fall through to needs_work", () => {
    expect(isLgtm("LGTM, but the variable naming is a bit weird and missing some edge cases.")).toBe(false);
    expect(isLgtm("LGTM. One issue: the function is missing a docstring.")).toBe(false);
  });

  test("explicit needs-work feedback", () => {
    expect(isLgtm("Tests fail: empty input case is not handled.")).toBe(false);
    expect(isLgtm("Issues:\n- missing edge case\n- bad naming")).toBe(false);
    expect(isLgtm("")).toBe(false);
  });

  test("LGTM-shaped strings that aren't a verdict", () => {
    expect(isLgtm("This implementation does not LGTM-style approve.")).toBe(false);
    expect(isLgtm("alignment is off, no LGTM here")).toBe(false);
  });
});
