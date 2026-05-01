import { describe, expect, test } from "bun:test";
import { generateTokens, lookupAgent, REVIEWER_PRINCIPAL } from "../orchestrator/auth";

describe("auth tokens", () => {
  test("generates a unique token per agent + reviewer principal", () => {
    const t = generateTokens(["alice", "bob", "carol"]);
    // 3 agents + reviewer = 4 entries
    expect(t.byAgent.size).toBe(4);
    expect(t.byToken.size).toBe(4);
    expect(t.byAgent.has(REVIEWER_PRINCIPAL)).toBe(true);
    const seen = new Set<string>();
    for (const tok of t.byAgent.values()) {
      // 32 random bytes, hex-encoded → 64 chars
      expect(tok.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(tok)).toBe(true);
      expect(seen.has(tok)).toBe(false);
      seen.add(tok);
    }
  });

  test("regenerating yields a new set of tokens", () => {
    const a = generateTokens(["alice"]);
    const b = generateTokens(["alice"]);
    expect(a.byAgent.get("alice")).not.toBe(b.byAgent.get("alice"));
  });

  test("lookupAgent maps token → agent and rejects unknowns", () => {
    const t = generateTokens(["alice", "bob"]);
    const aliceTok = t.byAgent.get("alice")!;
    expect(lookupAgent(t, aliceTok)).toBe("alice");
    expect(lookupAgent(t, "deadbeef")).toBe(null);
    expect(lookupAgent(t, "")).toBe(null);
    expect(lookupAgent(t, undefined)).toBe(null);
    expect(lookupAgent(t, null)).toBe(null);
  });

  test("reviewer token round-trips through lookupAgent", () => {
    const t = generateTokens(["alice"]);
    const rev = t.byAgent.get(REVIEWER_PRINCIPAL)!;
    expect(lookupAgent(t, rev)).toBe(REVIEWER_PRINCIPAL);
  });
});
