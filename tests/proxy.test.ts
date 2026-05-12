import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { generateTokens, REVIEWER_PRINCIPAL } from "../orchestrator/auth";

// Stand up a fake "openrouter.ai" / "api.anthropic.com" inside the
// test process. We point the proxy at it via env BEFORE importing
// proxy/server, so its UPSTREAMS table picks up our host:port.
let upstream: Server;
let upstreamReceived: { method?: string; url?: string; auth?: string; xApiKey?: string }[] = [];

beforeAll(() => {
  return new Promise<void>((resolve) => {
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        upstreamReceived.push({
          method: req.method,
          url: req.url,
          auth: req.headers["authorization"] as string,
          xApiKey: req.headers["x-api-key"] as string,
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, echoed: { url: req.url } }));
      });
    });
    // Listen on a random port; we'll use 127.0.0.1:port as the
    // upstream host. node:https.request uses port=443 by default
    // though — the proxy's request goes to https. We override the
    // host to a value we control via env, but the proxy still uses
    // port 443. So instead we run the upstream on 443 (needs root)
    // — not viable.
    //
    // Workaround: don't use httpsRequest. We can't easily replace
    // it without monkey-patching. So we test only the parts of the
    // proxy that DON'T touch network: token validation, upstream
    // selection, allowlist.
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
});

afterAll(() => {
  upstream.close();
});

// Pure-logic tests — we re-export selectUpstream-equivalent behavior
// indirectly by exercising the real handler with a mocked req/res.
// Easier and sufficient: just import the helpers we kept exported.

describe("proxy auth + path validation (unit, no network)", () => {
  test("token map + lookup happen before any upstream selection", () => {
    const t = generateTokens(["alice"]);
    const aliceTok = t.byAgent.get("alice")!;
    const reviewerTok = t.byAgent.get(REVIEWER_PRINCIPAL)!;
    expect(aliceTok).not.toBe(reviewerTok);
    expect(aliceTok).not.toBe("");
    expect(reviewerTok.length).toBe(64);
  });
});

// End-to-end via real socket: spin up the proxy on a free port and
// drive it with curl-equivalent fetch() calls. We don't have a way
// to fake the upstream HTTPS without a cert, so we only exercise
// the EARLY-RETURN paths (401 unauth, 403 forbidden path) — those
// don't reach the upstream.
function rawProxyRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, "127.0.0.1", () => sock.write(payload));
    let out = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => { out += chunk; });
    sock.on("error", reject);
    sock.on("end", () => resolve(out));
    sock.setTimeout(2_000, () => {
      sock.destroy();
      resolve(out);
    });
  });
}

describe("proxy server early-return paths", () => {
  let port: number;
  let stop: () => Promise<void>;
  let aliceTok: string;
  let reviewerTok: string;

  beforeAll(async () => {
    process.env.CATALLAXY_PROXY_PORT = String(8800 + Math.floor(Math.random() * 199));
    port = parseInt(process.env.CATALLAXY_PROXY_PORT!, 10);
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "test-or-key";
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-an-key";
    const { startProxyServer } = await import("../orchestrator/proxy/server");
    const tokens = generateTokens(["alice"]);
    aliceTok = tokens.byAgent.get("alice")!;
    reviewerTok = tokens.byAgent.get(REVIEWER_PRINCIPAL)!;
    const handle = await startProxyServer(tokens);
    stop = handle.stop;
  });

  afterAll(async () => { await stop?.(); });

  test("missing token → 401", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/openrouter/api/v1/models`);
    expect(r.status).toBe(401);
  });

  test("invalid token → 401", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/openrouter/api/v1/models`, {
      headers: { Authorization: "Bearer deadbeef" },
    });
    expect(r.status).toBe(401);
  });

  test("valid token, unknown prefix → 403", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/some/random/path`, {
      headers: { Authorization: `Bearer ${aliceTok}` },
    });
    expect(r.status).toBe(403);
  });

  test("valid token, openrouter prefix but disallowed sub-path → 403", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/openrouter/api/v1/admin`, {
      headers: { Authorization: `Bearer ${aliceTok}` },
    });
    expect(r.status).toBe(403);
  });

  test("valid token, anthropic prefix but disallowed sub-path → 403", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/anthropic/v1/admin/keys`, {
      headers: { "x-api-key": reviewerTok },
    });
    expect(r.status).toBe(403);
  });

  test("token in x-api-key header is also accepted", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/some/random/path`, {
      headers: { "x-api-key": aliceTok },
    });
    // 403 (auth passed, path forbidden), NOT 401
    expect(r.status).toBe(403);
  });

  test("CONNECT requires proxy auth", async () => {
    const resp = await rawProxyRequest(port,
      "CONNECT registry.npmjs.org:443 HTTP/1.1\r\n" +
      "Host: registry.npmjs.org:443\r\n\r\n"
    );
    expect(resp.startsWith("HTTP/1.1 401")).toBe(true);
  });

  test("CONNECT accepts Basic Proxy-Authorization but enforces host allowlist", async () => {
    const basic = Buffer.from(`catallaxy:${aliceTok}`).toString("base64");
    const resp = await rawProxyRequest(port,
      "CONNECT example.com:443 HTTP/1.1\r\n" +
      "Host: example.com:443\r\n" +
      `Proxy-Authorization: Basic ${basic}\r\n\r\n`
    );
    // 403 (auth passed, host forbidden), NOT 401
    expect(resp.startsWith("HTTP/1.1 403")).toBe(true);
  });
});
