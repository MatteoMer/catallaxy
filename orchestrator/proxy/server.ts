/**
 * Multi-upstream egress proxy with per-agent auth tokens.
 *
 * One HTTP listener at $CATALLAXY_PROXY_PORT (default 8443) handles
 * all agents AND the reviewer. The caller presents its catallaxy token
 * via X-Catallaxy-Token / Authorization / Proxy-Authorization; the proxy
 * validates it (via the TokenMap) on every request, identifies the caller,
 * picks an upstream by path prefix (`/openrouter/...`, `/anthropic/...`),
 * strips the caller-supplied Authorization, injects the
 * orchestrator's real upstream key, and forwards to the upstream
 * over HTTPS.
 *
 * OpenRouter/Anthropic calls use normal HTTP proxying so the host can
 * inject upstream API keys. CONNECT is only enabled as an authenticated,
 * host-allowlisted tunnel for package-manager HTTPS egress (`npm install`
 * and friends); it is never used for model traffic. Pi agents are
 * configured via models.json baseUrl. The reviewer currently runs pi on
 * the host by default using local Codex auth; this proxy remains available
 * for providers routed through it.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tcpConnect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { recordProxyAudit } from "./audit";
import { lookupAgent, type TokenMap } from "../auth";

const PROXY_PORT = parseInt(process.env.CATALLAXY_PROXY_PORT ?? "8443", 10);
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

// Package managers need HTTPS egress for `npm install`, but agents
// should not get arbitrary internet access. We therefore expose a
// CONNECT forward-proxy on the same authenticated proxy port and only
// tunnel to explicitly allowed package registry/CDN hosts. Operators
// can extend this comma-separated list for campaigns that need extra
// binary mirrors.
const DEFAULT_CONNECT_ALLOWLIST = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "binaries.prisma.sh",
  "cdn.playwright.dev",
  "playwright.azureedge.net",
];
const connectAllowlistRaw =
  process.env.CATALLAXY_CONNECT_ALLOWLIST?.trim() ||
  process.env.CATALLAXY_PACKAGE_EGRESS_HOSTS?.trim() ||
  DEFAULT_CONNECT_ALLOWLIST.join(",");
const CONNECT_ALLOWLIST = connectAllowlistRaw
  .split(",")
  .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
  .filter(Boolean);

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
const CONNECT_RATE_LIMIT_PER_MIN = parseInt(process.env.CATALLAXY_CONNECT_RATE_LIMIT ?? "1200", 10);
const RATE_WINDOW_MS = 60_000;
const rateState = new Map<string, { count: number; windowStart: number }>();
const connectRateState = new Map<string, { count: number; windowStart: number }>();

function rateLimitedIn(
  state: Map<string, { count: number; windowStart: number }>,
  limit: number,
  agent: string,
): boolean {
  if (limit <= 0) return false;
  const now = Date.now();
  const s = state.get(agent);
  if (!s || now - s.windowStart >= RATE_WINDOW_MS) {
    state.set(agent, { count: 1, windowStart: now });
    return false;
  }
  s.count++;
  return s.count > limit;
}

function rateLimited(agent: string): boolean {
  return rateLimitedIn(rateState, RATE_LIMIT_PER_MIN, agent);
}

function connectRateLimited(agent: string): boolean {
  return rateLimitedIn(connectRateState, CONNECT_RATE_LIMIT_PER_MIN, agent);
}

export interface ProxyServerHandle {
  stop: () => Promise<void>;
  port: number;
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (typeof v === "string" && v) return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return null;
}

function tokenFromProxyAuthorization(header: string | null): string | null {
  if (!header) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (bearer) return bearer[1];

  const basic = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!basic) return null;
  try {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return decoded || null;
    // Proxy URLs are emitted as http://catallaxy:<token>@proxy.
    // Accept token-as-password, and token-as-username for manual curl.
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    return pass || user || null;
  } catch {
    return null;
  }
}

function extractToken(req: IncomingMessage): string | null {
  // Explicit header wins.
  const explicit = firstHeader(req.headers["x-catallaxy-token"]);
  if (explicit) return explicit;

  // Forward-proxy clients (npm/curl/git via HTTPS_PROXY) authenticate
  // with Proxy-Authorization. The configured URL uses Basic auth.
  const proxyAuthToken = tokenFromProxyAuthorization(firstHeader(req.headers["proxy-authorization"]));
  if (proxyAuthToken) return proxyAuthToken;

  // Fall back to whatever upstream auth header the SDK populated.
  // Pi sets `--api-key` → Authorization: Bearer <key>; Anthropic SDKs
  // often set x-api-key. Either way the caller's catallaxy token rides
  // in there.
  const auth = firstHeader(req.headers["authorization"]);
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const apiKeyHdr = firstHeader(req.headers["x-api-key"]);
  if (apiKeyHdr) return apiKeyHdr;
  return null;
}

function parseConnectTarget(raw: string | undefined): { host: string; port: number } | null {
  if (!raw || raw.includes("/") || raw.includes("@")) return null;
  const bracket = /^\[([^\]]+)\]:(\d+)$/.exec(raw);
  if (bracket) {
    // No IPv6 literals in the package allowlist.
    return null;
  }
  const i = raw.lastIndexOf(":");
  if (i <= 0 || i === raw.length - 1) return null;
  const host = raw.slice(0, i).toLowerCase().replace(/\.$/, "");
  const port = Number(raw.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) return null;
  return { host, port };
}

function connectHostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const pat of CONNECT_ALLOWLIST) {
    if (pat.startsWith("*.")) {
      const suffix = pat.slice(1); // includes leading dot
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === pat) {
      return true;
    }
  }
  return false;
}

function writeConnectResponse(socket: Socket, status: number, reason: string, body = reason): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
      `Connection: close\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body
    );
  } catch {}
  socket.end();
}

function handleConnect(tokens: TokenMap, req: IncomingMessage, socket: Socket, head: Buffer): void {
  const token = extractToken(req);
  const agent = lookupAgent(tokens, token);
  const targetPath = req.url ?? "";
  if (!agent) {
    writeConnectResponse(socket, 401, "Unauthorized", "missing or invalid catallaxy auth token");
    return;
  }

  if (connectRateLimited(agent)) {
    writeConnectResponse(socket, 429, "Too Many Requests", `CONNECT rate limit exceeded (${CONNECT_RATE_LIMIT_PER_MIN}/min)`);
    void recordProxyAudit({
      agent, method: "CONNECT", path: targetPath,
      status: 429, bytesIn: 0, bytesOut: 0,
      at: new Date().toISOString(),
    });
    return;
  }

  const target = parseConnectTarget(targetPath);
  if (!target || target.port !== 443 || !connectHostAllowed(target.host)) {
    writeConnectResponse(socket, 403, "Forbidden", `forbidden CONNECT '${targetPath}'`);
    console.log(`[proxy:${agent}] DENY CONNECT ${targetPath}`);
    void recordProxyAudit({
      agent, method: "CONNECT", path: targetPath,
      status: 403, bytesIn: 0, bytesOut: 0,
      at: new Date().toISOString(),
    });
    return;
  }

  const upstream = tcpConnect(target.port, target.host);
  let established = false;
  let settled = false;
  const audit = (status: number) => {
    if (settled) return;
    settled = true;
    void recordProxyAudit({
      agent, method: "CONNECT", path: `${target.host}:${target.port}`,
      status, bytesIn: head?.length ?? 0, bytesOut: 0,
      at: new Date().toISOString(),
    });
  };

  upstream.once("connect", () => {
    established = true;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
    console.log(`[proxy:${agent}] CONNECT ${target.host}:${target.port} → 200`);
    audit(200);
  });
  upstream.once("error", (e) => {
    console.error(`[proxy:${agent}] CONNECT upstream error:`, e.message);
    if (established) {
      try { socket.destroy(); } catch {}
    } else if (!socket.destroyed) {
      writeConnectResponse(socket, 502, "Bad Gateway", "upstream error");
      audit(502);
    }
  });
  socket.once("error", () => upstream.destroy());
  socket.once("close", () => upstream.destroy());
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

export async function startProxyServer(tokens: TokenMap): Promise<ProxyServerHandle> {
  // Pre-flight: require at least the OpenRouter key. Anthropic key
  // is loaded lazily on first reviewer call; missing it will 503 the
  // reviewer but not break agents.
  UPSTREAMS[0].apiKey();
  const server: Server = createServer((req, res) => handleRequest(tokens, req, res));
  server.on("connect", (req, socket, head) => handleConnect(tokens, req, socket as Socket, head));
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
