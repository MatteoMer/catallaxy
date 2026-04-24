import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type { Task, TaskStatus, ChannelMessage } from "./types.js";

export interface TaskDb {
  insert(task: Task): void;
  getById(id: string): Task | undefined;
  updateStatus(id: string, status: TaskStatus, fields?: { result?: string; error?: string }): void;
  listPending(): Task[];
  hasRunning(): boolean;
  resetRunning(): number;
  insertChannelMessage(channelId: string, from: string, type: string, content: string): void;
  getChannelMessages(channelId: string): ChannelMessage[];
}

export function openTaskDb(agentId: string): TaskDb {
  mkdirSync("./data", { recursive: true });

  const db = new Database(`./data/${agentId}.db`);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      from_agent  TEXT NOT NULL,
      content     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'queued',
      reward      REAL NOT NULL DEFAULT 0,
      result      TEXT,
      error       TEXT,
      reply_url   TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
    CREATE INDEX IF NOT EXISTS idx_tasks_reward ON tasks (reward DESC);

    CREATE TABLE IF NOT EXISTS channel_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id  TEXT NOT NULL,
      from_agent  TEXT NOT NULL,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages (channel_id);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO tasks (id, from_agent, content, status, reward, result, error, reply_url, created_at, updated_at)
    VALUES (@id, @from_agent, @content, @status, @reward, @result, @error, @reply_url, @created_at, @updated_at)
  `);

  const getByIdStmt = db.prepare(`SELECT * FROM tasks WHERE id = ?`);

  const updateStatusStmt = db.prepare(`
    UPDATE tasks SET status = @status, result = @result, error = @error, updated_at = @updated_at WHERE id = @id
  `);

  const listPendingStmt = db.prepare(`
    SELECT * FROM tasks WHERE status = 'queued' ORDER BY reward DESC, created_at ASC
  `);

  const hasRunningStmt = db.prepare(`SELECT 1 FROM tasks WHERE status = 'running' LIMIT 1`);

  const resetRunningStmt = db.prepare(`UPDATE tasks SET status = 'queued', updated_at = @updated_at WHERE status = 'running'`);

  const insertChannelMsgStmt = db.prepare(`
    INSERT INTO channel_messages (channel_id, from_agent, type, content, created_at)
    VALUES (@channel_id, @from_agent, @type, @content, @created_at)
  `);

  const getChannelMsgsStmt = db.prepare(`SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY id ASC`);

  function rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as string,
      from: row.from_agent as string,
      content: row.content as string,
      status: row.status as TaskStatus,
      reward: row.reward as number,
      result: row.result as string | undefined,
      error: row.error as string | undefined,
      reply_url: row.reply_url as string | undefined,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  return {
    insert(task: Task): void {
      insertStmt.run({
        id: task.id,
        from_agent: task.from,
        content: task.content,
        status: task.status,
        reward: task.reward,
        result: task.result ?? null,
        error: task.error ?? null,
        reply_url: task.reply_url ?? null,
        created_at: task.created_at,
        updated_at: task.updated_at,
      });
    },

    getById(id: string): Task | undefined {
      const row = getByIdStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToTask(row) : undefined;
    },

    updateStatus(id: string, status: TaskStatus, fields?: { result?: string; error?: string }): void {
      updateStatusStmt.run({
        id,
        status,
        result: fields?.result ?? null,
        error: fields?.error ?? null,
        updated_at: new Date().toISOString(),
      });
    },

    listPending(): Task[] {
      const rows = listPendingStmt.all() as Record<string, unknown>[];
      return rows.map(rowToTask);
    },

    hasRunning(): boolean {
      return !!hasRunningStmt.get();
    },

    resetRunning(): number {
      const result = resetRunningStmt.run({ updated_at: new Date().toISOString() });
      return result.changes;
    },

    insertChannelMessage(channelId: string, from: string, type: string, content: string): void {
      insertChannelMsgStmt.run({
        channel_id: channelId,
        from_agent: from,
        type,
        content,
        created_at: new Date().toISOString(),
      });
    },

    getChannelMessages(channelId: string): ChannelMessage[] {
      const rows = getChannelMsgsStmt.all(channelId) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: row.id as number,
        channel_id: row.channel_id as string,
        from: row.from_agent as string,
        type: row.type as ChannelMessage["type"],
        content: row.content as string,
        created_at: row.created_at as string,
      }));
    },
  };
}
