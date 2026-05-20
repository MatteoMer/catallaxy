/**
 * Runtime knobs for agent containers.
 *
 * Default is the dev-server profile: agents still only persist /sandbox, but
 * the container behaves like a normal dev box (writable overlay, broad network,
 * Docker socket when available, larger memory/shm). Set
 * CATALLAXY_SANDBOX_PROFILE=secure for the old locked-down runtime.
 */

export type SandboxProfile = "devserver" | "secure";

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["0", "false", "off", "no", "disabled"].includes(v)) return false;
  if (["1", "true", "on", "yes", "enabled"].includes(v)) return true;
  return fallback;
}

export function sandboxProfile(): SandboxProfile {
  const raw = (process.env.CATALLAXY_SANDBOX_PROFILE ?? process.env.CATALLAXY_AGENT_PROFILE ?? "devserver")
    .trim()
    .toLowerCase();
  if (["secure", "locked", "prod", "production", "hardened"].includes(raw)) return "secure";
  return "devserver";
}

export function isDevServerProfile(): boolean {
  return sandboxProfile() === "devserver";
}

export function agentNetwork(): string {
  return process.env.CATALLAXY_AGENT_NETWORK?.trim()
    || (isDevServerProfile() ? "bridge" : "catallaxy-agents");
}

export function gatewayHost(): string {
  const explicit = process.env.CATALLAXY_GATEWAY_HOST?.trim();
  if (explicit) return explicit;

  const network = agentNetwork();
  if (network === "catallaxy-agents") return "catallaxy-gateway";
  if (network === "host") return "127.0.0.1";
  return "host.docker.internal";
}

export function proxyPort(): string {
  return process.env.CATALLAXY_PROXY_PORT?.trim() || "8443";
}

export function rpcPort(): string {
  return process.env.CATALLAXY_RPC_PORT?.trim() || "9443";
}

export function proxyBaseUrl(): string {
  return `http://${gatewayHost()}:${proxyPort()}`;
}

export function rpcAddr(): string {
  return `${gatewayHost()}:${rpcPort()}`;
}

export function dockerSocketPath(): string {
  return process.env.CATALLAXY_DOCKER_SOCKET?.trim() || "/var/run/docker.sock";
}

export function dockerAccessEnabled(): boolean {
  return envFlag("CATALLAXY_ENABLE_DOCKER", isDevServerProfile());
}

export function requireDockerSocket(): boolean {
  return envFlag("CATALLAXY_REQUIRE_DOCKER_SOCKET", false);
}

export function agentMemoryLimit(): string {
  return process.env.CATALLAXY_AGENT_MEMORY?.trim() || (isDevServerProfile() ? "8g" : "2g");
}

export function agentCpuLimit(): string {
  return process.env.CATALLAXY_AGENT_CPUS?.trim() || (isDevServerProfile() ? "4" : "1");
}

export function agentPidsLimit(): string {
  return process.env.CATALLAXY_AGENT_PIDS?.trim() || (isDevServerProfile() ? "4096" : "512");
}

export function agentShmSize(): string {
  return process.env.CATALLAXY_AGENT_SHM?.trim() || (isDevServerProfile() ? "2g" : "512m");
}

export function secureTmpSize(): string {
  return process.env.CATALLAXY_AGENT_TMP?.trim() || "512m";
}

export function secureHomeTmpSize(): string {
  return process.env.CATALLAXY_AGENT_HOME?.trim() || "128m";
}
