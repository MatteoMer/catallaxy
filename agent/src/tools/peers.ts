import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";
import type { PeerConfig, ToolDefinition, ToolResult, TaskResponse } from "../types.js";
import type { Logger } from "../logging.js";
import type { TaskDb } from "../db.js";

export function getPeerTools(
  peers: PeerConfig[],
  agentId: string,
  selfUrl: string,
  logger: Logger,
  walletPrivateKey: `0x${string}`,
  db: TaskDb,
): {
  definitions: ToolDefinition[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
} {
  const mppxClient = Mppx.create({
    methods: [tempo.charge({ account: privateKeyToAccount(walletPrivateKey) })],
    polyfill: false,
  });

  const peerMap = new Map<string, PeerConfig>();
  // Maps channel_id (= remote task_id) → peer config for result fetching
  const channelPeers = new Map<string, PeerConfig>();

  const messageDefinitions: ToolDefinition[] = peers.map((peer) => {
    const toolName = `message_${peer.id}`;
    peerMap.set(toolName, peer);
    return {
      name: toolName,
      description: `Send a message to ${peer.id}: ${peer.description}. Returns a channel_id. Use read_channel to get the response.`,
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

  const readChannelDef: ToolDefinition = {
    name: "read_channel",
    description: "Wait for a response on a channel from a peer. Polls until the peer replies (up to 2 minutes). For completed tasks, auto-fetches the paid result via mppx.",
    input_schema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "The channel_id returned when you sent the message" },
      },
      required: ["channel_id"],
    },
  };

  const definitions: ToolDefinition[] = [...messageDefinitions, readChannelDef];

  const dispatch = async (name: string, input: Record<string, unknown>): Promise<ToolResult> => {
    // read_channel tool
    if (name === "read_channel") {
      const channelId = input.channel_id as string;
      const peer = channelPeers.get(channelId);

      logger.log("read_channel_start", { channel_id: channelId, peer_id: peer?.id });

      // Poll for channel messages every 5s, up to 2 min
      const maxWait = 120_000;
      const interval = 5_000;
      const start = Date.now();

      while (Date.now() - start < maxWait) {
        const messages = db.getChannelMessages(channelId);
        const terminal = messages.find((m) => m.type === "completed" || m.type === "failed" || m.type === "rejected");

        if (terminal) {
          if (terminal.type === "completed" && peer) {
            // Auto-fetch the paid result via mppx
            try {
              const res = await mppxClient.fetch(`${peer.url}/message/${channelId}/result`);
              if (!res.ok) {
                const text = await res.text();
                return `Peer ${peer.id} completed but result fetch failed: ${res.status} ${text}`;
              }
              const json = (await res.json()) as { result: string };
              return json.result ?? "(no result)";
            } catch (err) {
              return `Peer ${peer.id} completed but cannot fetch result: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          // failed or rejected — return the content directly
          return `${terminal.type}: ${terminal.content}`;
        }

        // Check for info messages
        const infoMsgs = messages.filter((m) => m.type === "info");
        if (infoMsgs.length > 0) {
          // Return info but keep polling? No — just note it. The caller can call again.
        }

        await new Promise((resolve) => setTimeout(resolve, interval));
      }

      return "No response yet — channel timed out after 2 minutes.";
    }

    // message_* tools
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

    // Register channel → peer mapping for read_channel
    channelPeers.set(task_id, peer);

    logger.log("peer_delegated", { peer_id: peer.id, task_id });
    return `Message sent to ${peer.id} (channel: ${task_id}). Use read_channel to get the response.`;
  };

  return { definitions, dispatch };
}
