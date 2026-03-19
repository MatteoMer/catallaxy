import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

const validConfig = {
  id: "test-agent",
  port: 4200,
  url: "http://test-agent:4200",
  model: "claude-sonnet-4-6",
  tools: ["web_search"],
  system_prompt: "You are a test agent.",
  peers: [],
  wallet_address: "0x1234567890abcdef1234567890abcdef12345678",
  wallet_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
};

describe("loadConfig", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.AGENT_CONFIG;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_CONFIG;
    } else {
      process.env.AGENT_CONFIG = originalEnv;
    }
  });

  it("parses a valid config with wallet fields", () => {
    process.env.AGENT_CONFIG = JSON.stringify(validConfig);
    const config = loadConfig();
    assert.equal(config.wallet_address, validConfig.wallet_address);
    assert.equal(config.wallet_private_key, validConfig.wallet_private_key);
  });

  it("throws when AGENT_CONFIG is missing", () => {
    delete process.env.AGENT_CONFIG;
    assert.throws(() => loadConfig(), /AGENT_CONFIG environment variable is required/);
  });

  it("throws when AGENT_CONFIG is invalid JSON", () => {
    process.env.AGENT_CONFIG = "not json";
    assert.throws(() => loadConfig(), /AGENT_CONFIG is not valid JSON/);
  });

  it("throws when wallet_address is missing", () => {
    const { wallet_address: _, ...noAddr } = validConfig;
    process.env.AGENT_CONFIG = JSON.stringify(noAddr);
    assert.throws(() => loadConfig(), /wallet_address/);
  });

  it("throws when wallet_address does not start with 0x", () => {
    process.env.AGENT_CONFIG = JSON.stringify({ ...validConfig, wallet_address: "bad" });
    assert.throws(() => loadConfig(), /wallet_address/);
  });

  it("throws when wallet_private_key is missing", () => {
    const { wallet_private_key: _, ...noKey } = validConfig;
    process.env.AGENT_CONFIG = JSON.stringify(noKey);
    assert.throws(() => loadConfig(), /wallet_private_key/);
  });

  it("throws when wallet_private_key does not start with 0x", () => {
    process.env.AGENT_CONFIG = JSON.stringify({ ...validConfig, wallet_private_key: "bad" });
    assert.throws(() => loadConfig(), /wallet_private_key/);
  });

  it("accepts optional price field", () => {
    process.env.AGENT_CONFIG = JSON.stringify({ ...validConfig, price: "0.10" });
    const config = loadConfig();
    assert.equal(config.price, "0.10");
  });

  it("defaults price to undefined when not provided", () => {
    process.env.AGENT_CONFIG = JSON.stringify(validConfig);
    const config = loadConfig();
    assert.equal(config.price, undefined);
  });
});
