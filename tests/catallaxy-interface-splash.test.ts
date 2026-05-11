import { expect, test } from "bun:test";
import { computeGalaxyWindow, renderGalaxySplash, splashHeight } from "../.pi/extensions/catallaxy-interface/splash";

test("splash scales to the current terminal window", () => {
  expect(splashHeight(24)).toBe(18);
  expect(splashHeight(40)).toBe(34);
  expect(splashHeight(80)).toBe(74);
});

test("galaxy computes center from current window and places catallaxy there", () => {
  const win = computeGalaxyWindow(80, 32);
  const lines = renderGalaxySplash(80, 32, "test-seed");
  expect(lines.length).toBe(win.height);
  expect(lines.every((line) => line.length === win.width)).toBe(true);
  expect(lines[win.titleRow].slice(win.titleCol, win.titleCol + "catallaxy".length)).toBe("catallaxy");
  expect(win.titleRow).toBe(Math.floor(32 / 2));
  expect(win.titleCol).toBe(Math.floor((80 - "catallaxy".length) / 2));
});

test("galaxy uses the full width on wide terminals", () => {
  const win = computeGalaxyWindow(260, 32);
  const lines = renderGalaxySplash(260, 32, "wide-screen");
  expect(win.width).toBe(260);
  expect(lines.every((line) => line.length === 260)).toBe(true);
  expect(win.titleCol).toBe(Math.floor((260 - "catallaxy".length) / 2));
});

test("galaxy seed is deterministic and changes the star field", () => {
  const a1 = renderGalaxySplash(100, 36, "alpha").join("\n");
  const a2 = renderGalaxySplash(100, 36, "alpha").join("\n");
  const b = renderGalaxySplash(100, 36, "beta").join("\n");
  expect(a1).toBe(a2);
  expect(a1).not.toBe(b);
});

test("galaxy splash contains a star field", () => {
  const joined = renderGalaxySplash(100, 36, "star-count").join("");
  const starCount = [...joined].filter((c) => ".*+oO'`".includes(c)).length;
  expect(starCount).toBeGreaterThan(100);
});
