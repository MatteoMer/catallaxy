/**
 * Single-port TCP RPC server with per-agent auth tokens.
 *
 * One listener at $CATALLAXY_RPC_PORT (default 9443) handles all
 * agents. Identity is established by the auth token sent in the
 * first request frame of each connection: server looks up the token
 * in the TokenMap, fixes the connection's agent name, and from then
 * on rejects any request whose `auth` field doesn't match.
 *
 * We use TCP (not Unix sockets) because Docker Desktop on macOS
 * doesn't bridge Unix sockets across the host↔VM boundary. A gateway
 * container forwards bridge-network traffic to this listener so that
 * the agent network can stay --internal (no internet egress).
 *
 * Wire format: line-delimited JSON. See ./protocol.ts.
 */

import {
  type RpcRequest, type RpcResponse,
  encodeMessage, RPC_ERROR,
} from "./protocol";
import { HANDLERS } from "./methods";
import { hashParams, recordAudit } from "./audit";
import { lookupAgent, REVIEWER_PRINCIPAL, type TokenMap } from "../auth";

const RPC_PORT = parseInt(process.env.CATALLAXY_RPC_PORT ?? "9443", 10);
const RATE_LIMIT_PER_MIN = parseInt(process.env.CATALLAXY_RPC_RATE_LIMIT ?? "120", 10);
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

export interface RpcServerHandle {
  stop: () => Promise<void>;
  port: number;
}

interface ConnState {
  /** Set after the first authenticated request — agent stays fixed for the connection. */
  agent: string | null;
  buffer: string;
}

export async function startRpcServer(tokens: TokenMap): Promise<RpcServerHandle> {
  const server = Bun.listen<ConnState>({
    hostname: "0.0.0.0",
    port: RPC_PORT,
    socket: {
      open(socket) {
        socket.data = { agent: null, buffer: "" };
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = socket.data.buffer.indexOf("\n")) >= 0) {
          const line = socket.data.buffer.slice(0, idx);
          socket.data.buffer = socket.data.buffer.slice(idx + 1);
          handleLine(socket, line, tokens);
        }
      },
      error(_socket, err) {
        console.error(`[rpc] socket error:`, err);
      },
      close() {},
    },
  });
  console.log(`[rpc] listening on :${RPC_PORT} (${tokens.byAgent.size} tokens)`);
  return {
    stop: async () => { try { server.stop(true); } catch {} },
    port: RPC_PORT,
  };
}

async function handleLine(socket: any, raw: string, tokens: TokenMap): Promise<void> {
  const line = raw.trim();
  if (!line) return;
  let req: RpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    socket.write(encodeMessage({
      id: 0,
      error: { code: RPC_ERROR.PARSE, message: "invalid JSON" },
    }));
    return;
  }
  const id = typeof req.id === "number" ? req.id : 0;
  if (typeof req.method !== "string") {
    socket.write(encodeMessage({
      id,
      error: { code: RPC_ERROR.INVALID_REQUEST, message: "missing method" },
    }));
    return;
  }

  // Auth: every frame carries the token. The first frame's token
  // pins the connection's agent; later frames must present the same
  // token (otherwise a connection-hijack attempt could switch
  // identity mid-stream).
  const claimed = lookupAgent(tokens, req.auth);
  if (!claimed || claimed === REVIEWER_PRINCIPAL) {
    socket.write(encodeMessage({
      id,
      error: { code: RPC_ERROR.UNAUTHORIZED, message: "missing or invalid auth token" },
    }));
    return;
  }
  if (socket.data.agent && socket.data.agent !== claimed) {
    socket.write(encodeMessage({
      id,
      error: { code: RPC_ERROR.UNAUTHORIZED, message: "token does not match this connection's agent" },
    }));
    return;
  }
  socket.data.agent = claimed;
  const agent = claimed;

  const handler = (HANDLERS as Record<string, (a: string, p: unknown) => Promise<unknown>>)[req.method];
  if (!handler) {
    socket.write(encodeMessage({
      id,
      error: { code: RPC_ERROR.UNKNOWN_METHOD, message: `unknown method '${req.method}'` },
    }));
    await recordAudit({
      agent, method: req.method, paramsHash: hashParams(req.params),
      ok: false, errCode: RPC_ERROR.UNKNOWN_METHOD, errMessage: "unknown method",
      at: new Date().toISOString(),
    });
    return;
  }
  if (rateLimited(agent)) {
    socket.write(encodeMessage({
      id,
      error: { code: RPC_ERROR.RATE_LIMITED, message: `rate limit exceeded (${RATE_LIMIT_PER_MIN}/min)` },
    }));
    await recordAudit({
      agent, method: req.method, paramsHash: hashParams(req.params),
      ok: false, errCode: RPC_ERROR.RATE_LIMITED, errMessage: "rate limited",
      at: new Date().toISOString(),
    });
    return;
  }
  try {
    const result = await handler(agent, req.params ?? {});
    socket.write(encodeMessage({ id, result } satisfies RpcResponse));
    await recordAudit({
      agent, method: req.method, paramsHash: hashParams(req.params),
      ok: true, at: new Date().toISOString(),
    });
  } catch (e: any) {
    const message = e instanceof Error ? e.message : String(e);
    const code = /required|must|invalid/i.test(message)
      ? RPC_ERROR.INVALID_PARAMS
      : RPC_ERROR.INTERNAL;
    socket.write(encodeMessage({
      id,
      error: { code, message },
    }));
    await recordAudit({
      agent, method: req.method, paramsHash: hashParams(req.params),
      ok: false, errCode: code, errMessage: message,
      at: new Date().toISOString(),
    });
  }
}
