import type { AgentConfig } from "./types.js";

export function loadConfig(): AgentConfig {
  const raw = process.env.AGENT_CONFIG;
  if (!raw) {
    throw new Error("AGENT_CONFIG environment variable is required");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_CONFIG is not valid JSON");
  }

  const config = parsed as Record<string, unknown>;

  if (typeof config.id !== "string" || !config.id) {
    throw new Error("config.id is required");
  }
  if (typeof config.port !== "number") {
    throw new Error("config.port must be a number");
  }
  if (typeof config.url !== "string" || !config.url) {
    throw new Error("config.url is required");
  }
  if (typeof config.model !== "string" || !config.model) {
    throw new Error("config.model is required");
  }
  if (!Array.isArray(config.tools)) {
    throw new Error("config.tools must be an array");
  }
  if (typeof config.system_prompt !== "string") {
    throw new Error("config.system_prompt is required");
  }
  if (!Array.isArray(config.peers)) {
    throw new Error("config.peers must be an array");
  }
  if (typeof config.wallet_address !== "string" || !config.wallet_address.startsWith("0x")) {
    throw new Error("config.wallet_address must be a hex string starting with 0x");
  }
  if (typeof config.wallet_private_key !== "string" || !config.wallet_private_key.startsWith("0x")) {
    throw new Error("config.wallet_private_key must be a hex string starting with 0x");
  }

  for (const [i, peer] of (config.peers as unknown[]).entries()) {
    const p = peer as Record<string, unknown>;
    if (typeof p?.id !== "string" || !p.id) {
      throw new Error(`config.peers[${i}].id is required`);
    }
    if (typeof p.url !== "string" || !p.url) {
      throw new Error(`config.peers[${i}].url is required`);
    }
    if (typeof p.description !== "string") {
      throw new Error(`config.peers[${i}].description is required`);
    }
  }

  return parsed as AgentConfig;
}
