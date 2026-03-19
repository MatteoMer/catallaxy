import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPeerTools } from "../tools/peers.js";
import type { Logger } from "../logging.js";

const noopLogger: Logger = { log() {} };
const testKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
const selfUrl = "http://agent-1:4200";

describe("getPeerTools", () => {
  it("returns empty definitions for no peers", () => {
    const { definitions } = getPeerTools([], "agent-1", selfUrl, noopLogger, testKey);
    assert.equal(definitions.length, 0);
  });

  it("creates one tool definition per peer", () => {
    const peers = [
      { id: "alpha", url: "http://alpha:4201", description: "Research agent" },
      { id: "beta", url: "http://beta:4202", description: "Code agent" },
    ];
    const { definitions } = getPeerTools(peers, "agent-1", selfUrl, noopLogger, testKey);
    assert.equal(definitions.length, 2);
    assert.equal(definitions[0].name, "message_alpha");
    assert.equal(definitions[1].name, "message_beta");
  });

  it("tool descriptions include peer id and description", () => {
    const peers = [{ id: "gamma", url: "http://gamma:4203", description: "Writer agent" }];
    const { definitions } = getPeerTools(peers, "agent-1", selfUrl, noopLogger, testKey);
    const tool = definitions[0] as { description?: string };
    assert.ok(tool.description!.includes("gamma"));
    assert.ok(tool.description!.includes("Writer agent"));
  });

  it("dispatch rejects unknown tool names", async () => {
    const { dispatch } = getPeerTools([], "agent-1", selfUrl, noopLogger, testKey);
    await assert.rejects(() => dispatch("message_unknown", { message: "hi" }), /Unknown peer tool/);
  });

  it("dispatch returns error message when peer is unreachable", async () => {
    const peers = [{ id: "down", url: "http://localhost:1", description: "Unreachable" }];
    const { dispatch } = getPeerTools(peers, "agent-1", selfUrl, noopLogger, testKey);
    const result = await dispatch("message_down", { message: "hi" });
    assert.ok(result.includes("Cannot reach peer down"));
  });
});
