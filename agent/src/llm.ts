import Anthropic from "@anthropic-ai/sdk";
import type { AgentState, ToolDefinition, ToolResult, ToolRegistry } from "./types.js";
import type { Logger } from "./logging.js";
import type { TokenStore } from "./auth/token-store.js";

const MAX_ITERATIONS = 20;
const SELECTION_MAX_ITERATIONS = 3;
const OAUTH_BETAS = "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
const OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

const SELECTION_SYSTEM_PROMPT = "You are an economic agent. Pick the most valuable task you can complete well given your specialization. Consider the reward and your ability to deliver quality output.";

export interface LLMClient {
  run(userMessage: string, state: AgentState): Promise<string>;
  selectTask(
    queueSummary: string,
    tools: ToolDefinition[],
    dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>,
  ): Promise<void>;
}

export function createLLMClient(
  model: string,
  systemPrompt: string,
  toolRegistry: ToolRegistry,
  logger: Logger,
  tokenStore?: TokenStore,
): LLMClient {
  const staticClient = tokenStore ? null : new Anthropic();

  async function getClient(): Promise<Anthropic> {
    if (staticClient) return staticClient;
    return new Anthropic({
      authToken: await tokenStore!.getAccessToken(),
      defaultHeaders: { "anthropic-beta": OAUTH_BETAS },
    });
  }

  const useOAuth = !!tokenStore;

  function buildSystem(prompt: string): Anthropic.MessageCreateParams["system"] {
    return useOAuth
      ? [
          { type: "text", text: OAUTH_SYSTEM_PREFIX },
          { type: "text", text: prompt },
        ]
      : prompt;
  }

  async function toolLoop(
    client: Anthropic,
    system: Anthropic.MessageCreateParams["system"],
    messages: Anthropic.MessageParam[],
    tools: ToolDefinition[],
    dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>,
    maxIterations: number,
    maxTokens: number,
  ): Promise<string> {
    for (let i = 0; i < maxIterations; i++) {
      logger.log("llm_call", {
        iteration: i,
        message_count: messages.length,
      });

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        tools: tools.length > 0 ? tools : undefined,
        messages,
      });

      logger.log("llm_response", {
        stop_reason: response.stop_reason,
        content_blocks: response.content.length,
        usage: response.usage,
        text: response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text.slice(0, 300))
          .join("\n") || undefined,
      });

      if (response.stop_reason === "end_turn") {
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === "text",
        );
        return textBlocks.map((b) => b.text).join("\n") || "(no text output)";
      }

      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        messages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          logger.log("tool_call", {
            tool: toolUse.name,
            input: JSON.stringify(toolUse.input).slice(0, 500),
          });
          try {
            const result = await dispatch(
              toolUse.name,
              toolUse.input as Record<string, unknown>,
            );
            logger.log("tool_result", {
              tool: toolUse.name,
              result: typeof result === "string" ? result.slice(0, 500) : "(non-string)",
            });
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.log("tool_error", { tool: toolUse.name, error: errorMsg });
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

      const fallbackText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return fallbackText || `(stopped with reason: ${response.stop_reason})`;
    }

    return "(max tool-use iterations reached)";
  }

  return {
    async run(userMessage: string, state: AgentState): Promise<string> {
      const statePrefix = `<agent_state>\n${JSON.stringify(state)}\n</agent_state>\n\n`;
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: statePrefix + userMessage },
      ];

      const client = await getClient();
      return toolLoop(
        client,
        buildSystem(systemPrompt),
        messages,
        toolRegistry.definitions,
        toolRegistry.dispatch,
        MAX_ITERATIONS,
        4096,
      );
    },

    async selectTask(
      queueSummary: string,
      tools: ToolDefinition[],
      dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>,
    ): Promise<void> {
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: queueSummary },
      ];

      const client = await getClient();
      await toolLoop(
        client,
        buildSystem(SELECTION_SYSTEM_PROMPT),
        messages,
        tools,
        dispatch,
        SELECTION_MAX_ITERATIONS,
        1024,
      );
    },
  };
}
