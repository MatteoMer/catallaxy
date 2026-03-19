import Anthropic from "@anthropic-ai/sdk";
import type { AgentState, ToolRegistry } from "./types.js";
import type { Logger } from "./logging.js";

const MAX_ITERATIONS = 20;

export interface LLMClient {
  run(userMessage: string, state: AgentState): Promise<string>;
}

export function createLLMClient(
  model: string,
  systemPrompt: string,
  toolRegistry: ToolRegistry,
  logger: Logger,
): LLMClient {
  const client = new Anthropic();

  return {
    async run(userMessage: string, state: AgentState): Promise<string> {
      const statePrefix = `<agent_state>\n${JSON.stringify(state)}\n</agent_state>\n\n`;
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: statePrefix + userMessage },
      ];

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        logger.log("llm_call", { iteration: i, message_count: messages.length });

        const response = await client.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
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
