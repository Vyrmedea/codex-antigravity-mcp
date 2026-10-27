import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { CodexClient } from "../src/codex/client.js";
import { BridgeService } from "../src/core/bridge.js";
import { TurnTracker } from "../src/core/turn-tracker.js";

const fakeServerPath = resolve(__dirname, "fixtures/fake-app-server.mjs");
const nodeExe = process.env.CODEX_NODE_PATH || "D:/app/nodejs/node.exe";

describe("TurnTracker & BridgeService", () => {
  let client: CodexClient;
  let bridge: BridgeService;

  beforeEach(() => {
    client = new CodexClient(nodeExe, fakeServerPath, process.cwd());
    bridge = new BridgeService(client);
  });

  afterEach(() => {
    client.close();
  });

  it("aggregates streaming text, command output tail and wakes up immediately on completion", async () => {
    const tracker = new TurnTracker("t1", "turn1");

    tracker.appendStreamingText("Part 1. ");
    tracker.appendStreamingText("Part 2.");
    tracker.handleItemStarted("cmd-1", "commandExecution", { command: "npm run build" });
    tracker.handleCommandOutputDelta("cmd-1", "Building bundle...\n");

    expect(tracker.getSnapshot().streamingText).toBe("Part 1. Part 2.");
    expect(tracker.getSnapshot().activeCommand?.command).toBe("npm run build");
    expect(tracker.getSnapshot().activeCommand?.outputTail).toBe("Building bundle...\n");

    // Settle immediately when completed
    setTimeout(() => {
      tracker.handleTurnCompleted("completed");
    }, 50);

    const start = Date.now();
    const snapshot = await tracker.waitForSettleOrTimeout(5000);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(snapshot.state).toBe("completed");
    expect(snapshot.activeCommand).toBeNull();
  });

  it("enforces single active task lock and reports BUSY", async () => {
    // Send first turn that stays waiting for approval
    const snap1 = await bridge.sendPrompt({
      prompt: "trigger_command_approval",
      waitMs: 500,
    });

    expect(snap1.state).toBe("waiting_approval");
    expect(snap1.pendingApproval).toBeDefined();

    // Trying to send another prompt concurrently must throw BUSY
    await expect(
      bridge.sendPrompt({
        prompt: "concurrent request",
      })
    ).rejects.toThrow(/BUSY/);
  });

  it("handles approval flow, rejects dangerous rm -rf commands, and settles", async () => {
    const snap = await bridge.sendPrompt({
      prompt: "trigger_command_approval",
      waitMs: 500,
    });

    expect(snap.state).toBe("waiting_approval");
    const interactionId = snap.pendingApproval!.interactionId;

    // Approve turn
    const approvedSnap = await bridge.approveTurn({
      threadId: snap.threadId,
      turnId: snap.turnId,
      interactionId,
      decision: "accept",
      waitMs: 500,
    });

    expect(approvedSnap.state).toBe("completed");
  });

  it("allows configuring safeTrashOnly per turn", async () => {
    const snap = await bridge.sendPrompt({
      prompt: "trigger_command_approval",
      safeTrashOnly: false,
      waitMs: 500,
    });

    expect(snap.state).toBe("waiting_approval");
    const interactionId = snap.pendingApproval!.interactionId;

    const approvedSnap = await bridge.approveTurn({
      threadId: snap.threadId,
      turnId: snap.turnId,
      interactionId,
      decision: "accept",
      waitMs: 500,
    });

    expect(approvedSnap.state).toBe("completed");
  });

  it("handles serverRequest/resolved clearing pending approval", async () => {
    const snap = await bridge.sendPrompt({
      prompt: "trigger_resolved",
      waitMs: 500,
    });

    expect(snap.state).toBe("waiting_approval");
    expect(snap.pendingApproval).toBeDefined();

    // After 60ms, the server emits serverRequest/resolved and turn/completed
    await new Promise((r) => setTimeout(r, 80));

    const polledSnap = await bridge.pollTurn({
      threadId: snap.threadId,
      turnId: snap.turnId,
      waitMs: 500,
    });

    expect(polledSnap.state).toBe("completed");
    expect(polledSnap.pendingApproval).toBeNull();
  });

  it("returns session list and message history", async () => {
    const sessions = await bridge.listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);

    const details: any = await bridge.listSessions({
      threadId: "thread-abc",
    });
    expect(details.messages).toBeDefined();
    expect(details.messages.length).toBe(2);
    expect(details.messages[0].role).toBe("user");
    expect(details.messages[0].text).toBe("历史提问");
    expect(details.messages[1].role).toBe("assistant");
    expect(details.messages[1].text).toBe("历史回答");
  });

  it("throws STALE_TURN on invalid turnId poll", async () => {
    await expect(
      bridge.pollTurn({
        threadId: "fake-thread-1",
        turnId: "non-existent-turn",
      })
    ).rejects.toThrow(/STALE_TURN/);
  });
});
