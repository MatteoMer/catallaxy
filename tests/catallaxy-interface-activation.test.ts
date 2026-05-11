import { expect, test } from "bun:test";
import { isCatallaxyInterfaceEnabled } from "../.pi/extensions/catallaxy-interface/activation";

test("interface extension is opt-in via catallaxy launcher env", () => {
  expect(isCatallaxyInterfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  expect(isCatallaxyInterfaceEnabled({ CATALLAXY_INTERFACE: "0" } as NodeJS.ProcessEnv)).toBe(false);
  expect(isCatallaxyInterfaceEnabled({ CATALLAXY_INTERFACE: "1" } as NodeJS.ProcessEnv)).toBe(true);
  expect(isCatallaxyInterfaceEnabled({ CATALLAXY_INTERFACE: "true" } as NodeJS.ProcessEnv)).toBe(true);
});
