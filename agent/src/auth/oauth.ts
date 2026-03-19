/**
 * Anthropic OAuth flow (Claude Pro/Max) via authorization code + PKCE.
 * Adapted for CLI usage — opens browser, listens on localhost callback.
 */

import { createServer, type Server } from "node:http";
import { generatePKCE } from "./pkce.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number; // epoch ms
}

function startCallbackServer(
  expectedState: string,
): Promise<{ server: Server; waitForCode: () => Promise<{ code: string; state: string } | null> }> {
  return new Promise((resolve, reject) => {
    let settle: ((v: { code: string; state: string } | null) => void) | undefined;
    const codePromise = new Promise<{ code: string; state: string } | null>((res) => {
      settle = res;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error || !code || !state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Authentication failed</h1><p>You can close this window.</p>");
        settle?.(null);
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch</h1><p>You can close this window.</p>");
        settle?.(null);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Authenticated!</h1><p>You can close this window and return to the terminal.</p>");
      settle?.({ code, state });
    });

    server.on("error", reject);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({ server, waitForCode: () => codePromise });
    });
  });
}

async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Run the interactive OAuth login flow.
 * Opens a browser to claude.ai, waits for callback on localhost.
 */
export async function login(): Promise<OAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const { server, waitForCode } = await startCallbackServer(verifier);

  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  const authUrl = `${AUTHORIZE_URL}?${params}`;
  console.log(`\nOpen this URL to authenticate:\n\n  ${authUrl}\n`);

  // Try to open browser automatically
  const { exec } = await import("node:child_process");
  const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${authUrl}"`);

  console.log("Waiting for authentication...");
  const result = await waitForCode();
  server.close();

  if (!result) {
    throw new Error("Authentication failed or was cancelled");
  }

  console.log("Exchanging authorization code for tokens...");
  return exchangeCode(result.code, result.state, verifier);
}

/**
 * Refresh an expired access token.
 */
export async function refreshToken(refreshTokenValue: string): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshTokenValue,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}
