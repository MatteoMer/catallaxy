import { randomUUID } from "node:crypto";
import type { AgentState, Task, ToolDefinition, ToolResult } from "./types.js";
import type { TaskDb } from "./db.js";
import type { LLMClient } from "./llm.js";
import type { Logger } from "./logging.js";
import { getTaskSelectionTools } from "./tools/tasks.js";
import { getTriageTools } from "./tools/triage.js";

export interface Agent {
  enqueue(from: string, content: string, reward?: number, replyUrl?: string): Task;
  getTask(id: string): Task | undefined;
  listPending(): Task[];
  getState(currentTask?: Task): AgentState;
}

export function createAgent(
  agentId: string,
  db: TaskDb,
  llm: LLMClient,
  logger: Logger,
  peerDefinitions: ToolDefinition[],
  peerDispatch: (name: string, input: Record<string, unknown>) => Promise<ToolResult>,
): Agent {
  let busy = false;

  // Recover any tasks left in "running" state from a previous crash
  const recovered = db.resetRunning();
  if (recovered > 0) {
    logger.log("tasks_recovered", { count: recovered });
  }

  async function sendChannelReply(
    task: Task,
    type: "completed" | "failed" | "rejected",
    content: string,
  ): Promise<void> {
    if (!task.reply_url) return;

    try {
      await fetch(`${task.reply_url}/channel/${task.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: agentId, type, content }),
      });
      logger.log("reply_sent", { task_id: task.id, to: task.from, type, reply_url: task.reply_url });
    } catch (err) {
      logger.log("reply_error", {
        task_id: task.id,
        to: task.from,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function executeTask(task: Task): Promise<void> {
    db.updateStatus(task.id, "running");
    logger.log("task_started", { task_id: task.id, from: task.from, reward: task.reward });

    // Phase 1: Evaluation — should we accept this?
    const { definitions: triageDefs, dispatch: triageDispatch, getResult: getTriageResult } = getTriageTools();
    const triageTools = triageDefs;

    const pendingCount = db.listPending().length;
    const triagePrompt = `You received a message from "${task.from}" (reward: ${task.reward} pathUSD).
You have ${pendingCount} pending messages in your queue.

<message>
${task.content}
</message>

Decide what to do in your own interest. You can reply to the sender or any peer to negotiate, ask questions, or decline. If you want to do the work, use the accept tool.`;

    const state = getState(task);
    logger.log("triage_start", { task_id: task.id, from: task.from, reward: task.reward, pending_count: pendingCount });
    const evalResponse = await llm.evaluate(triagePrompt, state, triageTools, triageDispatch);
    const triageResult = getTriageResult();
    const accepted = !!triageResult?.accepted;
    logger.log("triage_result", { task_id: task.id, accepted, response: evalResponse.slice(0, 500) });

    if (!accepted) {
      db.updateStatus(task.id, "rejected", { result: evalResponse });
      logger.log("task_rejected", { task_id: task.id, from: task.from, response: evalResponse.slice(0, 300) });
      sendChannelReply(task, "rejected", evalResponse).catch((err) => {
        logger.log("reply_error", { task_id: task.id, error: String(err) });
      });
      return;
    }

    logger.log("task_accepted", { task_id: task.id, from: task.from, reward: task.reward });

    // Phase 2: Execution
    try {
      const result = await llm.run(task.content, state);
      db.updateStatus(task.id, "completed", { result });
      logger.log("task_completed", { task_id: task.id });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      db.updateStatus(task.id, "failed", { error });
      logger.log("task_failed", { task_id: task.id, error });
    }

    // Notify sender via channel (lightweight, no task creation on their side)
    const updated = db.getById(task.id)!;
    if (updated.status === "completed") {
      sendChannelReply(updated, "completed", "").catch((err) => {
        logger.log("reply_error", { task_id: task.id, error: String(err) });
      });
    } else {
      sendChannelReply(updated, "failed", updated.error ?? "Unknown error").catch((err) => {
        logger.log("reply_error", { task_id: task.id, error: String(err) });
      });
    }
  }

  async function maybeStartSelection(): Promise<void> {
    if (busy) return;
    if (db.hasRunning()) return;

    const pending = db.listPending();
    if (pending.length === 0) return;

    busy = true;

    try {
      if (pending.length === 1) {
        // Single task — auto-pick, no LLM call needed
        await executeTask(pending[0]);
      } else {
        // Multiple tasks — let LLM choose
        const { definitions, dispatch, getSelection } = getTaskSelectionTools(db);

        const rows = pending.map((t) => {
          const snippet = t.content.length > 80 ? t.content.slice(0, 80) + "…" : t.content;
          return `| ${t.id} | ${t.from} | ${t.reward} | ${snippet} |`;
        });
        const queueSummary = `You have ${pending.length} queued tasks. Pick the one you can complete most effectively:\n\n| ID | From | Reward | Content |\n|---|---|---|---|\n${rows.join("\n")}`;

        logger.log("task_selection_start", { pending_count: pending.length });

        await llm.selectTask(queueSummary, definitions, dispatch);

        const selection = getSelection();
        if (selection?.type === "pick" && selection.taskId) {
          const picked = db.getById(selection.taskId);
          if (picked && picked.status === "queued") {
            logger.log("task_selected", { task_id: selection.taskId, reward: picked.reward });
            await executeTask(picked);
          }
        } else {
          logger.log("task_selection_skipped", { pending_count: pending.length });
        }
      }
    } catch (err) {
      logger.log("worker_error", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      busy = false;
      // Check for more work
      maybeStartSelection().catch((err) => {
        logger.log("worker_error", { error: String(err) });
      });
    }
  }

  function getState(currentTask?: Task): AgentState {
    const pending = db.listPending();
    return {
      agent_id: agentId,
      pending_task_count: pending.length,
      current_task: currentTask
        ? { id: currentTask.id, from: currentTask.from, content: currentTask.content, reward: currentTask.reward }
        : undefined,
    };
  }

  return {
    enqueue(from: string, content: string, reward = 0, replyUrl?: string): Task {
      const task: Task = {
        id: randomUUID(),
        from,
        content,
        status: "queued",
        reward,
        reply_url: replyUrl,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      db.insert(task);
      logger.log("task_enqueued", { task_id: task.id, from, reward });

      maybeStartSelection().catch((err) => {
        logger.log("worker_error", { error: String(err) });
      });

      return task;
    },

    getTask(id: string): Task | undefined {
      return db.getById(id);
    },

    listPending(): Task[] {
      return db.listPending();
    },

    getState,
  };
}
