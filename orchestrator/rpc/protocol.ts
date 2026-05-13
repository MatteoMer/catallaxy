/**
 * RPC protocol — line-delimited JSON envelope between agents and the
 * orchestrator. Each frame carries a per-agent auth token; the server
 * looks the token up and pins the connection to that agent. Messages do
 * not carry a trusted agent identity field.
 *
 * Request:  {"id":N,"method":"...","params":{...},"auth":"token"}\n
 * Response: {"id":N,"result":...}\n
 *       or  {"id":N,"error":{"code":N,"message":"..."}}\n
 */

export type RpcMethod =
  | "list_tasks"
  | "task_info"
  | "my_assignments"
  | "task_verdicts"
  | "create_task"
  | "my_created_tasks"
  | "cancel_created_task"
  | "merge_task_result"
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
