import type { PeerConfig, ToolDefinition, ToolResult, TaskResponse } from "../types.js";
import type { Logger } from "../logging.js";

export function getPeerTools(
  peers: PeerConfig[],
  agentId: string,
  selfUrl: string,
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
      description: `Send a task to ${peer.id}: ${peer.description}. The message should describe what you need from this peer. This is fire-and-forget: you'll get a confirmation that the task was sent, and ${peer.id} will message you back with the result when done.`,
      input_schema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "The message to send to the peer" },
          reward: { type: "number", description: "The reward to offer for completing this task (in pathUSD). Higher rewards attract better effort." },
        },
        required: ["message"],
      },
    };
  });

  const dispatch = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const peer = peerMap.get(name);
    if (!peer) throw new Error(`Unknown peer tool: ${name}`);

    logger.log("peer_request", { peer_id: peer.id, message: input.message });

    let postRes: Response;
    try {
      postRes = await fetch(`${peer.url}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: agentId, content: input.message, reward: input.reward ?? 0, reply_url: selfUrl }),
      });
    } catch (err) {
      const msg = `Cannot reach peer ${peer.id} at ${peer.url}: ${err instanceof Error ? err.message : String(err)}`;
      logger.log("peer_error", { peer_id: peer.id, error: msg });
      return msg;
    }

    if (!postRes.ok) {
      const errorText = await postRes.text();
      return `Error contacting ${peer.id}: ${postRes.status} ${errorText}`;
    }

    let task_id: string;
    try {
      const json = (await postRes.json()) as TaskResponse;
      task_id = json.task_id;
    } catch {
      return `Peer ${peer.id} returned invalid JSON on POST /message`;
    }
    if (!task_id) {
      return `Peer ${peer.id} did not return a task_id`;
    }

    logger.log("peer_delegated", { peer_id: peer.id, task_id });
    return `Task sent to ${peer.id} (task_id: ${task_id}). They will message you back with the result.`;
  };

  return { definitions, dispatch };
}
