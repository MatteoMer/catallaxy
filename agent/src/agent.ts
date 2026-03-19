import { randomUUID } from "node:crypto";
import type { AgentState, Task } from "./types.js";
import type { LLMClient } from "./llm.js";
import type { Logger } from "./logging.js";

export interface Agent {
  enqueue(from: string, content: string, replyUrl?: string): Task;
  getTask(id: string): Task | undefined;
  getState(): AgentState;
}

export function createAgent(agentId: string, llm: LLMClient, logger: Logger): Agent {
  const state: AgentState = {
    agent_id: agentId,
    tasks: [],
  };

  let processing = false;

  async function sendReply(task: Task): Promise<void> {
    if (!task.reply_url) return;

    const content = task.status === "completed"
      ? `Result from ${agentId} for your task (${task.id}): ${task.result}`
      : `Error from ${agentId} for your task (${task.id}): ${task.error}`;

    try {
      await fetch(`${task.reply_url}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: agentId, content }),
      });
      logger.log("reply_sent", { task_id: task.id, to: task.from, reply_url: task.reply_url });
    } catch (err) {
      logger.log("reply_error", {
        task_id: task.id,
        to: task.from,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function processNext(): Promise<void> {
    if (processing) return;

    const next = state.tasks.find((t) => t.status === "queued");
    if (!next) return;

    processing = true;
    next.status = "running";
    next.updated_at = new Date().toISOString();
    logger.log("task_started", { task_id: next.id, from: next.from });

    try {
      const result = await llm.run(next.content, state);
      next.status = "completed";
      next.result = result;
      logger.log("task_completed", { task_id: next.id });
    } catch (err) {
      next.status = "failed";
      next.error = err instanceof Error ? err.message : String(err);
      logger.log("task_failed", { task_id: next.id, error: next.error });
    } finally {
      next.updated_at = new Date().toISOString();
      processing = false;

      sendReply(next).catch((err) => {
        logger.log("reply_error", { task_id: next.id, error: String(err) });
      });

      processNext().catch((err) => {
        logger.log("worker_error", { error: String(err) });
      });
    }
  }

  return {
    enqueue(from: string, content: string, replyUrl?: string): Task {
      const task: Task = {
        id: randomUUID(),
        from,
        content,
        status: "queued",
        reply_url: replyUrl,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.tasks.push(task);
      logger.log("task_enqueued", { task_id: task.id, from });

      processNext().catch((err) => {
        logger.log("worker_error", { error: String(err) });
      });

      return task;
    },

    getTask(id: string): Task | undefined {
      return state.tasks.find((t) => t.id === id);
    },

    getState(): AgentState {
      return state;
    },
  };
}
