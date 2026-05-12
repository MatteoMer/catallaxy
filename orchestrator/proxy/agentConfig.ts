/**
 * Per-agent pi config (models.json) generation.
 *
 * Pi reads provider overrides from `${PI_CODING_AGENT_DIR}/models.json`.
 * We point the openrouter provider at the gateway-backed proxy so all
 * model traffic flows through the orchestrator.
 *
 * The config dir is mounted into the container as read-only, separate
 * from the agent's writable /sandbox, so the agent's bash can't
 * rewrite its own config to bypass the proxy.
 */

import { mkdir, writeFile } from "node:fs/promises";

const ROOT = process.cwd();
const AGENTS_DIR = process.env.AGENTS_DIR ?? `${ROOT}/agents`;

export function configDirFor(agent: string): string {
  return `${AGENTS_DIR}/${agent}/.pi-config`;
}

/**
 * Write per-agent pi config.
 *
 * `baseUrl` points at the egress gateway (which forwards to the
 * host's proxy). The auth token is delivered via pi's `--api-key`
 * flag — pi forwards it as `Authorization: Bearer <token>` and the
 * proxy maps that back to the agent before injecting the real key.
 * No custom headers needed in models.json.
 */
export async function writeAgentConfig(agent: string, _authToken: string): Promise<string> {
  const dir = configDirFor(agent);
  await mkdir(dir, { recursive: true });
  const config = {
    providers: {
      openrouter: {
        baseUrl: `http://catallaxy-gateway:8443/openrouter/api/v1`,
      },
    },
  };
  await writeFile(`${dir}/models.json`, JSON.stringify(config, null, 2));
  // Pre-create the files pi tries to ensure-exist at startup, so a
  // read-only mount of this dir doesn't trip its mkdirSync /
  // writeFileSync paths.
  await writeFile(`${dir}/auth.json`, "{}");
  await writeFile(`${dir}/settings.json`, "{}");
  return dir;
}
