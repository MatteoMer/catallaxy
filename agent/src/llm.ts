import Anthropic from "@anthropic-ai/sdk";
import type { AgentState, ToolRegistry } from "./types.js";
import type { Logger } from "./logging.js";
import type { TokenStore } from "./auth/token-store.js";

const MAX_ITERATIONS = 20;
const OAUTH_BETAS = "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
const OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface LLMClient {
  run(userMessage: string, state: AgentState): Promise<string>;
}

export function createLLMClient(
  model: string,
  systemPrompt: string,
  toolRegistry: ToolRegistry,
  logger: Logger,
  tokenStore?: TokenStore,
): LLMClient {
  // When using OAuth (Claude Max), we create a new client per call with a fresh token.
  // When using API key, we reuse a single client.
  const staticClient = tokenStore ? null : new Anthropic();

  return {
    async run(userMessage: string, state: AgentState): Promise<string> {
      const statePrefix = `<agent_state>\n${JSON.stringify(state)}\n</agent_state>\n\n`;
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: statePrefix + userMessage },
      ];

      const useOAuth = !!tokenStore;
      const client = staticClient ?? new Anthropic({
        authToken: await tokenStore!.getAccessToken(),
        defaultHeaders: { "anthropic-beta": OAUTH_BETAS },
      });

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        logger.log("llm_call", { iteration: i, message_count: messages.length });

        // OAuth requires system prompt to start with the Claude Code identity string
        const system: Anthropic.MessageCreateParams["system"] = useOAuth
          ? [
              { type: "text", text: OAUTH_SYSTEM_PREFIX },
              { type: "text", text: systemPrompt },
            ]
          : systemPrompt;

        const response = await client.messages.create({
          model,
          max_tokens: 4096,
          system,
          tools: toolRegistry.definitions.length > 0 ? toolRegistry.definitions : undefined,
          messages,
        });

        logger.log("llm_response", {
          stop_reason: response.stop_reason,
          content_blocks: response.content.length,
        });

        // Extract text from response
        if (response.stop_reason === "end_turn") {
          const textBlocks = response.content.filter(
            (b): b is Anthropic.TextBlock => b.type === "text",
          );
          return textBlocks.map((b) => b.text).join("\n") || "(no text output)";
        }

        // Handle tool use
        if (response.stop_reason === "tool_use") {
          const toolUseBlocks = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );

          // Add assistant message with all content blocks
          messages.push({ role: "assistant", content: response.content });

          // Execute each tool and collect results
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const toolUse of toolUseBlocks) {
            try {
              const result = await toolRegistry.dispatch(
                toolUse.name,
                toolUse.input as Record<string, unknown>,
              );
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: `Error: ${errorMsg}`,
                is_error: true,
              });
            }
          }

          messages.push({ role: "user", content: toolResults });
          continue;
        }

        // Unknown stop reason — return whatever text we have
        const fallbackText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return fallbackText || `(stopped with reason: ${response.stop_reason})`;
      }

      return "(max tool-use iterations reached)";
    },
  };
}
