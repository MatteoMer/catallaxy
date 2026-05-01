/**
 * Per-agent auth tokens.
 *
 * Generated at orchestrator startup, kept in memory only. The token
 * is passed to the container via env (`CATALLAXY_AUTH_TOKEN`); the
 * RPC server validates it on the first frame of each connection and
 * the egress proxy validates it on every request via
 * `X-Catallaxy-Token`.
 *
 * Why tokens at all: the RPC and proxy listeners bind on the bridge
 * interface so containers can reach them. Without tokens, anything
 * else on the host network namespace (or other containers if ICC
 * were on) could connect to those ports and impersonate any agent.
 * With tokens, the impersonator needs to also know the agent's
 * secret — which lives in env on a single ephemeral container and
 * is never written to disk.
 */

import { randomBytes } from "node:crypto";

export interface TokenMap {
  /** agent name → secret token (32 bytes, hex-encoded) */
  byAgent: Map<string, string>;
  /** secret token → agent name (reverse lookup) */
  byToken: Map<string, string>;
}

/** Reserved name for the reviewer's token in the TokenMap. */
export const REVIEWER_PRINCIPAL = "_reviewer";

/**
 * Build a TokenMap for `agents` plus the reserved reviewer
 * principal. The reviewer's token is treated like any other for
 * proxy authz, but it never appears in the agents list passed into
 * the RPC server (so the reviewer cannot call agent-only RPC
 * methods even if it presented its token there).
 */
export function generateTokens(agents: string[]): TokenMap {
  const byAgent = new Map<string, string>();
  const byToken = new Map<string, string>();
  for (const principal of [...agents, REVIEWER_PRINCIPAL]) {
    const tok = randomBytes(32).toString("hex");
    byAgent.set(principal, tok);
    byToken.set(tok, principal);
  }
  return { byAgent, byToken };
}

export function lookupAgent(tokens: TokenMap, token: string | undefined | null): string | null {
  if (!token) return null;
  return tokens.byToken.get(token) ?? null;
}
