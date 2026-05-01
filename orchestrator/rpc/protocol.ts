/**
 * RPC protocol — line-delimited JSON envelope between agents and the
 * orchestrator. Each connection is identified by which Unix socket it
 * arrived on (the orchestrator listens on a per-agent socket), so
 * messages do not carry an agent identity field.
 *
 * Request:  {"id":N,"method":"...","params":{...}}\n
 * Response: {"id":N,"result":...}\n
 *       or  {"id":N,"error":{"code":N,"message":"..."}}\n
 */

export type RpcMethod =
  | "list_tasks"
  | "task_info"
  | "my_assignments"
  | "task_verdicts"
  | "place_bid"
  | "request_review"
  | "my_balance"
  | "history";

export interface RpcRequest {
  id: number;
  method: RpcMethod;
  params?: Record<string, unknown>;
  /** Per-agent shared secret. Required on the first request of every connection. */
  auth?: string;
}

export interface RpcOk {
  id: number;
  result: unknown;
}

export interface RpcErr {
  id: number;
  error: { code: number; message: string };
}

export type RpcResponse = RpcOk | RpcErr;

export const RPC_ERROR = {
  PARSE: 1,
  INVALID_REQUEST: 2,
  UNKNOWN_METHOD: 3,
  INVALID_PARAMS: 4,
  INTERNAL: 5,
  RATE_LIMITED: 6,
  UNAUTHORIZED: 7,
} as const;

export function encodeMessage(msg: RpcResponse): string {
  return JSON.stringify(msg) + "\n";
}
