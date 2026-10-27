import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { JsonRpcConnection } from "../src/codex/jsonrpc.js";
import { CodexClient } from "../src/codex/client.js";

const fakeServerPath = resolve(__dirname, "fixtures/fake-app-server.mjs");
const nodeExe = process.env.CODEX_NODE_PATH || "D:/app/nodejs/node.exe";

describe("JsonRpcConnection & CodexClient", () => {
  let conn: JsonRpcConnection | null = null;
  let client: CodexClient | null = null;

  afterEach(() => {
    if (conn) {
      conn.close();
      conn = null;
    }
    if (client) {
      client.close();
      client = null;
    }
  });

  it("handles basic request and response roundtrip", async () => {
    conn = new JsonRpcConnection(nodeExe, [fakeServerPath], process.cwd());
    conn.start();

    const res = await conn.request<any>("initialize", {
      clientInfo: { name: "test", version: "1.0" },
    });

    expect(res).toBeDefined();
    expect(res.userAgent).toBe("fake-codex-cli");
    expect(res.platformFamily).toBe("windows");
  });

  it("rejects in-flight requests on unexpected process exit", async () => {
    conn = new JsonRpcConnection(nodeExe, [fakeServerPath], process.cwd());
    conn.start();

    // Trigger process exit inside turn/start
    await expect(
      conn.request("turn/start", {
        input: [{ type: "text", text: "die_exit" }],
      })
    ).rejects.toThrow(/aborted: Child process/);
  });

  it("rejects in-flight requests on stdout EOF", async () => {
    conn = new JsonRpcConnection(nodeExe, [fakeServerPath], process.cwd());
    conn.start();

    await expect(
      conn.request("turn/start", {
        input: [{ type: "text", text: "close_stdout" }],
      })
    ).rejects.toThrow(/aborted: Child process stdout/);
  });

  it("initializes CodexClient and verifies sourceKinds in thread/list", async () => {
    // In our test, codexBin will point to fakeServerPath
    client = new CodexClient(nodeExe, fakeServerPath, process.cwd());

    await client.ensureConnected();
    expect(client.isConnected()).toBe(true);

    const listRes = await client.listThreads({ limit: 10 });
    expect(listRes.threads).toHaveLength(1);
    expect(listRes.echoSourceKinds).toEqual([
      "cli",
      "vscode",
      "exec",
      "appServer",
      "unknown",
    ]);
  });

  it("verifies permissions mapping in startThread and startTurn", async () => {
    client = new CodexClient(nodeExe, fakeServerPath, process.cwd());

    const threadRes = await client.startThread({
      cwd: "D:/test-cwd",
      permissionMode: "full-access",
    });
    expect(threadRes.thread.id).toBe("fake-thread-1");

    const turnRes = await client.startTurn({
      threadId: "fake-thread-1",
      prompt: "run something",
      effectiveCwd: "D:/test-cwd",
      permissionMode: "supervised",
    });
    expect(turnRes.turn.id).toBe("turn-100");
  });

  it("handles reverse approval requests and response formatting", async () => {
    client = new CodexClient(nodeExe, fakeServerPath, process.cwd());

    let receivedApprovalReq: any = null;
    client.onServerRequest((req) => {
      receivedApprovalReq = req;
    });

    const turnPromise = client.startTurn({
      threadId: "fake-thread-1",
      prompt: "trigger_command_approval",
      effectiveCwd: "D:/test-cwd",
    });

    // Wait briefly for server request to arrive
    for (let i = 0; i < 20; i++) {
      if (receivedApprovalReq) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(receivedApprovalReq).toBeDefined();
    expect(receivedApprovalReq.id).toBe(9001);
    expect(receivedApprovalReq.method).toBe("item/commandExecution/requestApproval");

    // Respond approval
    client.respondApproval(9001, "command_approval", "accept");

    const turnRes = await turnPromise;
    expect(turnRes.turn.id).toBe("turn-100");
  });

  it("handles user_input approval answers formatting", async () => {
    client = new CodexClient(nodeExe, fakeServerPath, process.cwd());

    let receivedUserInputReq: any = null;
    client.onServerRequest((req) => {
      receivedUserInputReq = req;
    });

    const turnPromise = client.startTurn({
      threadId: "fake-thread-1",
      prompt: "trigger_user_input",
      effectiveCwd: "D:/test-cwd",
    });

    for (let i = 0; i < 20; i++) {
      if (receivedUserInputReq) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(receivedUserInputReq).toBeDefined();
    expect(receivedUserInputReq.id).toBe(9003);

    client.respondApproval(9003, "user_input", "accept", {
      answers: { q1: "yes" },
    });

    const turnRes = await turnPromise;
    expect(turnRes.turn.id).toBe("turn-100");
  });
});
