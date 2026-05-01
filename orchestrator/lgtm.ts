/**
 * Robust LGTM detection for reviewer output.
 *
 * The prompt asks for `LGTM` and nothing else, but claude often
 * adds a preamble or trailing context anyway ("All 10 tests pass.
 * Implementation correctly uses Kahn's algorithm... LGTM"). The
 * verdict is what matters, not the strictness of the format.
 *
 * We accept LGTM if it appears as the FIRST or LAST non-empty line
 * (modulo whitespace and trailing punctuation), and there is no
 * later contradicting "needs work" / "fix" signal.
 *
 * If the verdict is ambiguous (e.g. "LGTM but…"), we default to
 * needs_work — the agent gets feedback to address rather than a
 * false approval.
 */

export function isLgtm(rawOutput: string): boolean {
  const lines = rawOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;

  const stripPunct = (s: string) => s.replace(/[.!?,;:]+$/, "").trim();
  const isPlainLgtm = (s: string) => /^lgtm$/i.test(stripPunct(s));

  const first = stripPunct(lines[0]);
  const last = stripPunct(lines[lines.length - 1]);

  // Single-token output (the spec) — easy.
  if (lines.length === 1 && isPlainLgtm(first)) return true;

  // First or last line is exactly LGTM (modulo punctuation).
  const lgtmAtBoundary = isPlainLgtm(first) || isPlainLgtm(last);
  if (!lgtmAtBoundary) return false;

  // Reject hedged approvals — if a clear "needs work" signal also
  // appears, treat as needs_work.
  const hedge = /\b(needs[\s_-]*work|must\s+fix|please\s+fix|issue|bug|incorrect|missing|broken|fails?)\b/i;
  if (hedge.test(rawOutput)) return false;

  return true;
}
