import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { CodexClient } from "../src/codex/client.js";
import { BridgeService } from "../src/core/bridge.js";
import { createMcpServer } from "../src/mcp/server.js";

const fakeServerPath = resolve(__dirname, "fixtures/fake-app-server.mjs");
const nodeExe = process.env.CODEX_NODE_PATH || "D:/app/nodejs/node.exe";

describe("MCP Server Tools", () => {
  let client: CodexClient;
  let bridge: BridgeService;
  let server: any;

  beforeEach(() => {
    client = new CodexClient(nodeExe, fakeServerPath, process.cwd());
    bridge = new BridgeService(client);
    server = createMcpServer(bridge);
  });

  afterEach(() => {
    client.close();
  });

  it("registers all 5 required tools", () => {
    // In @modelcontextprotocol/sdk McpServer, tools are stored in _registeredTools or tools
    const tools = (server as any)._registeredTools || (server as any).tools;
    expect(tools).toBeDefined();
    const toolNames = Object.keys(tools);
    expect(toolNames).toContain("codex_send");
    expect(toolNames).toContain("codex_poll");
    expect(toolNames).toContain("codex_approve");
    expect(toolNames).toContain("codex_cancel");
    expect(toolNames).toContain("codex_sessions");
  });

  it("invokes codex_send and codex_poll successfully", async () => {
    const sendResult = await bridge.sendPrompt({
      prompt: "Hello MCP",
      waitMs: 500,
    });

    expect(sendResult.state).toBe("completed");
    expect(sendResult.streamingText).toBe("Hello World!");

    const pollResult = await bridge.pollTurn({
      threadId: sendResult.threadId,
      turnId: sendResult.turnId,
      waitMs: 100,
    });

    expect(pollResult.state).toBe("completed");
    expect(pollResult.turnId).toBe(sendResult.turnId);
  });

  it("invokes codex_sessions and returns formatted data", async () => {
    const sessions: any = await bridge.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions[0].threadId).toBe("thread-abc");

    const history: any = await bridge.listSessions({
      threadId: "thread-abc",
    });
    expect(history.messages).toHaveLength(2);
  });
});
