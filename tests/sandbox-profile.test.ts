import { afterEach, describe, expect, test } from "bun:test";
import {
  agentNetwork,
  dockerAccessEnabled,
  gatewayHost,
  proxyBaseUrl,
  requireDockerSocket,
  rpcAddr,
  sandboxProfile,
} from "../orchestrator/sandboxProfile";

const ENV_KEYS = [
  "CATALLAXY_SANDBOX_PROFILE",
  "CATALLAXY_AGENT_PROFILE",
  "CATALLAXY_AGENT_NETWORK",
  "CATALLAXY_GATEWAY_HOST",
  "CATALLAXY_PROXY_PORT",
  "CATALLAXY_RPC_PORT",
  "CATALLAXY_ENABLE_DOCKER",
  "CATALLAXY_REQUIRE_DOCKER_SOCKET",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnv);

describe("sandbox profile env parsing", () => {
  test("defaults to devserver with bridge network and host gateway", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    expect(sandboxProfile()).toBe("devserver");
    expect(agentNetwork()).toBe("bridge");
    expect(gatewayHost()).toBe("host.docker.internal");
    expect(proxyBaseUrl()).toBe("http://host.docker.internal:8443");
    expect(rpcAddr()).toBe("host.docker.internal:9443");
    expect(dockerAccessEnabled()).toBe(true);
    expect(requireDockerSocket()).toBe(false);
  });

  test("secure aliases select the locked-down gateway network", () => {
    for (const alias of ["secure", "locked", "prod", "production", "hardened"]) {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.CATALLAXY_SANDBOX_PROFILE = alias;

      expect(sandboxProfile()).toBe("secure");
      expect(agentNetwork()).toBe("catallaxy-agents");
      expect(gatewayHost()).toBe("catallaxy-gateway");
      expect(dockerAccessEnabled()).toBe(false);
    }
  });

  test("devserver aliases are accepted explicitly", () => {
    for (const alias of ["devserver", "dev-server", "dev", "development", "default", ""]) {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.CATALLAXY_SANDBOX_PROFILE = alias;

      expect(sandboxProfile()).toBe("devserver");
    }
  });

  test("explicit network, host, ports, and flags override profile defaults", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.CATALLAXY_SANDBOX_PROFILE = "secure";
    process.env.CATALLAXY_AGENT_NETWORK = "host";
    process.env.CATALLAXY_GATEWAY_HOST = "gw.local";
    process.env.CATALLAXY_PROXY_PORT = "18443";
    process.env.CATALLAXY_RPC_PORT = "19443";
    process.env.CATALLAXY_ENABLE_DOCKER = "yes";
    process.env.CATALLAXY_REQUIRE_DOCKER_SOCKET = "on";

    expect(agentNetwork()).toBe("host");
    expect(gatewayHost()).toBe("gw.local");
    expect(proxyBaseUrl()).toBe("http://gw.local:18443");
    expect(rpcAddr()).toBe("gw.local:19443");
    expect(dockerAccessEnabled()).toBe(true);
    expect(requireDockerSocket()).toBe(true);
  });

  test("invalid profile names fail closed instead of silently using devserver", () => {
    process.env.CATALLAXY_SANDBOX_PROFILE = "secur";
    expect(() => sandboxProfile()).toThrow("invalid sandbox profile");
  });
});
