import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");

describe("generate-compose.ts", () => {
  it("generates valid YAML with wallet fields for each agent", () => {
    const output = execSync("npx tsx generate-compose.ts", {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    // Should contain wallet_address and wallet_private_key for agents
    assert.ok(output.includes("wallet_address"), "output should contain wallet_address");
    assert.ok(output.includes("wallet_private_key"), "output should contain wallet_private_key");
  });

  it("generates unique wallet addresses per agent", () => {
    const output = execSync("npx tsx generate-compose.ts", {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    // Extract all wallet addresses from the YAML
    const addressMatches = output.match(/"wallet_address":"(0x[a-fA-F0-9]+)"/g);
    assert.ok(addressMatches, "should find wallet addresses");
    assert.ok(addressMatches.length >= 10, `should have at least 10 addresses (9 agents + control), got ${addressMatches.length}`);

    const addresses = addressMatches.map((m) => m.match(/"(0x[a-fA-F0-9]+)"/)?.[1]);
    const uniqueAddresses = new Set(addresses);
    assert.ok(uniqueAddresses.size >= 10, `should have at least 10 unique addresses, got ${uniqueAddresses.size}`);
  });

  it("generates wallet addresses starting with 0x", () => {
    const output = execSync("npx tsx generate-compose.ts", {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    const addressMatches = output.match(/"wallet_address":"(0x[a-fA-F0-9]+)"/g);
    assert.ok(addressMatches);
    for (const match of addressMatches) {
      const addr = match.match(/"(0x[a-fA-F0-9]+)"/)?.[1];
      assert.ok(addr?.startsWith("0x"), `address should start with 0x: ${addr}`);
      assert.equal(addr?.length, 42, `address should be 42 chars (0x + 40 hex): ${addr}`);
    }
  });

  it("includes control agent with wallet", () => {
    const output = execSync("npx tsx generate-compose.ts", {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    // The control section should also have wallet fields
    const controlSection = output.split("control:").pop()!;
    assert.ok(controlSection.includes("wallet_address"), "control agent should have wallet_address");
    assert.ok(controlSection.includes("wallet_private_key"), "control agent should have wallet_private_key");
  });
});
