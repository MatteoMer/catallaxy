/**
 * Multi-upstream egress proxy with per-agent auth tokens.
 *
 * One HTTP listener at $CATALLAXY_PROXY_PORT (default 8443) handles
 * all agents AND the reviewer. The caller is started with
 * X-Catallaxy-Token = <its secret>; the proxy validates the header
 * (via the TokenMap) on every request, identifies the caller, picks
 * an upstream by path prefix (`/openrouter/...`, `/anthropic/...`),
 * strips the caller-supplied Authorization, injects the
 * orchestrator's real upstream key, and forwards to the upstream
 * over HTTPS.
 *
 * No CONNECT / HTTPS-tunneling: end-to-end TLS would defeat key
 * injection. Pi (agents) is configured via models.json baseUrl, and
 * claude (reviewer) via ANTHROPIC_BASE_URL — both plain HTTP into
 * this proxy.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { recordProxyAudit } from "./audit";
import { lookupAgent, type TokenMap } from "../auth";

const PROXY_PORT = parseInt(process.env.CATALLAXY_PROXY_PORT ?? "8443", 10);
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

interface Upstream {
  host: string;
  /** Path prefix the caller hits (e.g. "/openrouter"). Stripped before forwarding. */
  prefix: string;
  /** Allowed paths AFTER the prefix is stripped. */
  allow: RegExp[];
  /** Returns the API key to inject. Throws if not configured. */
  apiKey: () => string;
}

function readKeyEnvOrFile(envName: string, fileFallback: string): string {
  const v = process.env[envName];
  if (v) return v;
  try { return readFileSync(`${process.cwd()}/orchestrator/private/${fileFallback}`, "utf-8").trim(); } catch {}
  throw new Error(`${envName} not in env and orchestrator/private/${fileFallback} not readable`);
}

const UPSTREAMS: Upstream[] = [
  {
    host: process.env.CATALLAXY_OPENROUTER_HOST ?? "openrouter.ai",
    prefix: "/openrouter",
    allow: [
      /^\/api\/v1\/chat\/completions\/?$/,
      /^\/api\/v1\/messages\/?$/,
      /^\/api\/v1\/models\/?$/,
      /^\/api\/v1\/completions\/?$/,
      /^\/api\/v1\/embeddings\/?$/,
    ],
    apiKey: () => readKeyEnvOrFile("OPENROUTER_API_KEY", "openrouter.key"),
  },
  {
    host: process.env.CATALLAXY_ANTHROPIC_HOST ?? "api.anthropic.com",
    prefix: "/anthropic",
    allow: [
      /^\/v1\/messages\/?$/,
      /^\/v1\/messages\/count_tokens\/?$/,
      /^\/v1\/models\/?$/,
      /^\/v1\/models\/[^/]+\/?$/,
    ],
    apiKey: () => readKeyEnvOrFile("ANTHROPIC_API_KEY", "anthropic.key"),
  },
];

function selectUpstream(pathname: string): { up: Upstream; rest: string } | null {
  for (const up of UPSTREAMS) {
    if (pathname === up.prefix || pathname.startsWith(up.prefix + "/")) {
      return { up, rest: pathname.slice(up.prefix.length) || "/" };
    }
  }
  return null;
}
const RATE_LIMIT_PER_MIN = parseInt(process.env.CATALLAXY_PROXY_RATE_LIMIT ?? "120", 10);
const RATE_WINDOW_MS = 60_000;
const rateState = new Map<string, { count: number; windowStart: number }>();

function rateLimited(agent: string): boolean {
  const now = Date.now();
  const s = rateState.get(agent);
  if (!s || now - s.windowStart >= RATE_WINDOW_MS) {
    rateState.set(agent, { count: 1, windowStart: now });
    return false;
  }
  s.count++;
  return s.count > RATE_LIMIT_PER_MIN;
}

export interface ProxyServerHandle {
  stop: () => Promise<void>;
  port: number;
}

function extractToken(req: IncomingMessage): string | null {
  // Explicit header wins.
  const explicit = req.headers["x-catallaxy-token"];
  if (typeof explicit === "string" && explicit) return explicit;
  if (Array.isArray(explicit) && explicit[0]) return explicit[0];
  // Fall back to whatever upstream auth header the SDK populated.
  // Pi sets `--api-key` → Authorization: Bearer <key>. Claude sets
  // ANTHROPIC_API_KEY → x-api-key: <key>. Either way the agent or
  // reviewer's catallaxy token rides in there.
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const apiKeyHdr = req.headers["x-api-key"];
  if (typeof apiKeyHdr === "string" && apiKeyHdr) return apiKeyHdr;
  if (Array.isArray(apiKeyHdr) && apiKeyHdr[0]) return apiKeyHdr[0];
  return null;
}

function handleRequest(tokens: TokenMap, req: IncomingMessage, res: ServerResponse): void {
  const token = extractToken(req);
  const agent = lookupAgent(tokens, token);
  if (!agent) {
    res.statusCode = 401;
    res.end("missing or invalid catallaxy auth token");
    return;
  }

  const url = req.url ?? "/";
  const q = url.indexOf("?");
  const pathname = q >= 0 ? url.slice(0, q) : url;
  const search = q >= 0 ? url.slice(q) : "";

  if (rateLimited(agent)) {
    res.statusCode = 429;
    res.end(`rate limit exceeded (${RATE_LIMIT_PER_MIN}/min)`);
    void recordProxyAudit({
      agent, method: req.method ?? "?", path: pathname,
      status: 429, bytesIn: 0, bytesOut: 0,
      at: new Date().toISOString(),
    });
    return;
  }

  const sel = selectUpstream(pathname);
  if (!sel || !sel.up.allow.some((re) => re.test(sel.rest))) {
    res.statusCode = 403;
    res.end(`forbidden path '${pathname}'`);
    console.log(`[proxy:${agent}] DENY ${req.method} ${pathname}`);
    void recordProxyAudit({
      agent, method: req.method ?? "?", path: pathname,
      status: 403, bytesIn: 0, bytesOut: 0,
      at: new Date().toISOString(),
    });
    return;
  }
  const { up, rest } = sel;

  let apiKey: string;
  try { apiKey = up.apiKey(); }
  catch (e: any) {
    res.statusCode = 503;
    res.end(`upstream key unavailable: ${e?.message ?? "unknown"}`);
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === "host" || k === "connection" || k === "content-length") continue;
    if (k === "x-catallaxy-token") continue;
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }
  delete headers["authorization"];
  delete headers["proxy-authorization"];
  delete headers["x-api-key"];
  // Anthropic prefers x-api-key, OpenRouter Bearer; set both
  // (Anthropic ignores Authorization, OpenRouter ignores x-api-key).
  headers["authorization"] = `Bearer ${apiKey}`;
  headers["x-api-key"] = apiKey;
  headers["host"] = up.host;

  let bytesIn = 0;
  let bytesOut = 0;
  let aborted = false;

  const upstream = httpsRequest(
    {
      host: up.host,
      port: 443,
      method: req.method,
      path: rest + search,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.on("data", (chunk: Buffer) => { bytesOut += chunk.length; });
      upstreamRes.pipe(res);
      upstreamRes.on("end", () => {
        console.log(`[proxy:${agent}] ${req.method} ${pathname} → ${upstreamRes.statusCode}`);
        void recordProxyAudit({
          agent,
          method: req.method ?? "?",
          path: pathname,
          status: upstreamRes.statusCode ?? 0,
          bytesIn,
          bytesOut,
          at: new Date().toISOString(),
        });
      });
    }
  );

  upstream.on("error", (e) => {
    if (aborted) return;
    console.error(`[proxy:${agent}] upstream error:`, e.message);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("upstream error");
    } else {
      try { res.end(); } catch {}
    }
  });

  req.on("data", (chunk: Buffer) => {
    bytesIn += chunk.length;
    if (bytesIn > MAX_REQUEST_BYTES) {
      aborted = true;
      upstream.destroy(new Error("request body too large"));
      if (!res.headersSent) {
        res.statusCode = 413;
        res.end("payload too large");
      }
      return;
    }
    upstream.write(chunk);
  });
  req.on("end", () => upstream.end());
  req.on("error", () => upstream.destroy());
}

function rejectConnect(_req: IncomingMessage, socket: any): void {
  try { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch {}
  socket.end();
  console.log(`[proxy] CONNECT denied`);
}

export async function startProxyServer(tokens: TokenMap): Promise<ProxyServerHandle> {
  // Pre-flight: require at least the OpenRouter key. Anthropic key
  // is loaded lazily on first reviewer call; missing it will 503 the
  // reviewer but not break agents.
  UPSTREAMS[0].apiKey();
  const server: Server = createServer((req, res) => handleRequest(tokens, req, res));
  server.on("connect", (req, socket) => rejectConnect(req, socket));
  server.on("error", (e) => console.error(`[proxy] server error:`, e));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PROXY_PORT, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  console.log(`[proxy] listening on :${PROXY_PORT} (${tokens.byAgent.size} tokens)`);
  return {
    stop: async () => {
      await new Promise<void>((res) => server.close(() => res()));
    },
    port: PROXY_PORT,
  };
}
