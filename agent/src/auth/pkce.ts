import { randomBytes, createHash } from "node:crypto";

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(verifier).digest();
  const challenge = digest.toString("base64url");
  return { verifier, challenge };
}
