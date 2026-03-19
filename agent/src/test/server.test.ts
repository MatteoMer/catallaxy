import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.js";
import type { Agent } from "../agent.js";
import type { AgentConfig, Task } from "../types.js";

const testConfig: AgentConfig = {
  id: "test-agent",
  port: 4200,
  url: "http://test-agent:4200",
  model: "claude-sonnet-4-6",
  tools: [],
  system_prompt: "test",
  peers: [],
  wallet_address: "0x1234567890abcdef1234567890abcdef12345678",
  wallet_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  price: "0.05",
};

function createMockAgent(): Agent {
  const tasks = new Map<string, Task>();
  return {
    enqueue(from: string, content: string): Task {
      const task: Task = {
        id: "task-123",
        from,
        content,
        status: "queued",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      tasks.set(task.id, task);
      return task;
    },
    getTask(id: string) {
      return tasks.get(id);
    },
    getState() {
      return { agent_id: "test-agent", tasks: Array.from(tasks.values()) };
    },
  };
}

describe("createServer", () => {
  it("returns 402 on POST /message without payment credential", async () => {
    const agent = createMockAgent();
    const app = createServer(agent, testConfig);

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "peer-1", content: "hello" }),
    });

    assert.equal(res.status, 402);
  });

  it("GET /health returns 200 without payment", async () => {
    const agent = createMockAgent();
    const app = createServer(agent, testConfig);

    const res = await app.request("/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.agent_id, "test-agent");
  });

  it("GET /tasks/:id returns 200 without payment for existing task", async () => {
    const agent = createMockAgent();
    const app = createServer(agent, testConfig);

    // Create a task first via the agent directly
    agent.enqueue("peer-1", "test");

    const res = await app.request("/tasks/task-123");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, "task-123");
  });

  it("GET /tasks/:id returns 404 for non-existent task", async () => {
    const agent = createMockAgent();
    const app = createServer(agent, testConfig);

    const res = await app.request("/tasks/nonexistent");
    assert.equal(res.status, 404);
  });
});
