/**
 * Persists OAuth credentials to disk and provides a fresh access token,
 * auto-refreshing when expired.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { type OAuthCredentials, refreshToken } from "./oauth.js";

const DEFAULT_TOKEN_PATH = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".catallaxy",
  "tokens.json",
);

export interface TokenStore {
  /** Returns a valid access token, refreshing if needed. */
  getAccessToken(): Promise<string>;
}

export async function saveCredentials(
  credentials: OAuthCredentials,
  path: string = DEFAULT_TOKEN_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2), "utf-8");
}

export async function loadCredentials(
  path: string = DEFAULT_TOKEN_PATH,
): Promise<OAuthCredentials> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as OAuthCredentials;
}

export function createTokenStore(path: string = DEFAULT_TOKEN_PATH): TokenStore {
  let cached: OAuthCredentials | null = null;

  return {
    async getAccessToken(): Promise<string> {
      if (!cached) {
        cached = await loadCredentials(path);
      }

      // Refresh if expired (or within 5 minutes of expiry — already baked into `expires`)
      if (Date.now() >= cached.expires) {
        cached = await refreshToken(cached.refresh);
        await saveCredentials(cached, path);
      }

      return cached.access;
    },
  };
}
