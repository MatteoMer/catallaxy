import type { PeerConfig, ToolDefinition, ToolResult, TaskResponse, Task } from "../types.js";
import type { Logger } from "../logging.js";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

export function getPeerTools(
  peers: PeerConfig[],
  agentId: string,
  logger: Logger,
): {
  definitions: ToolDefinition[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
} {
  const peerMap = new Map<string, PeerConfig>();

  const definitions: ToolDefinition[] = peers.map((peer) => {
    const toolName = `message_${peer.id}`;
    peerMap.set(toolName, peer);
    return {
      name: toolName,
      description: `Send a message to ${peer.id}: ${peer.description}. The message should describe what you need from this peer.`,
      input_schema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "The message to send to the peer" },
        },
        required: ["message"],
      },
    };
  });

  const dispatch = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const peer = peerMap.get(name);
    if (!peer) throw new Error(`Unknown peer tool: ${name}`);

    logger.log("peer_request", { peer_id: peer.id, message: input.message });

    // POST message to peer
    const postRes = await fetch(`${peer.url}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: agentId, content: input.message }),
    });

    if (!postRes.ok) {
      const errorText = await postRes.text();
      return `Error contacting ${peer.id}: ${postRes.status} ${errorText}`;
    }

    const { task_id } = (await postRes.json()) as TaskResponse;

    // Poll for completion
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const pollRes = await fetch(`${peer.url}/tasks/${task_id}`);
      if (!pollRes.ok) continue;

      const task = (await pollRes.json()) as Task;
      if (task.status === "completed") {
        logger.log("peer_response", { peer_id: peer.id, task_id, result: task.result });
        return task.result ?? "Task completed with no output";
      }
      if (task.status === "failed") {
        logger.log("peer_error", { peer_id: peer.id, task_id, error: task.error });
        return `Peer ${peer.id} failed: ${task.error}`;
      }
    }

    return `Timeout waiting for ${peer.id} to complete task ${task_id}`;
  };

  return { definitions, dispatch };
}
