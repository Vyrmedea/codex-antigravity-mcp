import { resolve } from "node:path";
import { CodexClient } from "../dist/codex/client.js";
import { DEFAULT_CONFIG } from "../dist/config.js";
import { BridgeService } from "../dist/core/bridge.js";

async function runSmoke() {
  console.log("=== [Codex MCP Smoke Test] Starting Real Codex Verification ===");
  console.log("Node executable:", DEFAULT_CONFIG.nodeExe);
  console.log("Codex binary:", DEFAULT_CONFIG.codexBin);
  console.log("Default CWD:", DEFAULT_CONFIG.defaultCwd);

  const client = new CodexClient(
    DEFAULT_CONFIG.nodeExe,
    DEFAULT_CONFIG.codexBin,
    DEFAULT_CONFIG.defaultCwd
  );
  const bridge = new BridgeService(client);

  try {
    // 1. Check sessions
    console.log("\n[1/4] Listing historical sessions...");
    const sessions = await bridge.listSessions({ limit: 5 });
    console.log(`Retrieved ${sessions.length} sessions.`);
    if (sessions.length > 0) {
      console.log(`Latest session: ID=${sessions[0].threadId}, title="${sessions[0].title}"`);
    }

    // 2. Turn 1: Start new conversation
    console.log("\n[2/4] Starting Turn 1 (New Conversation)...");
    const prompt1 = "请仅输出一句话: 'MCP第一轮握手成功', 不要执行任何命令, 不要调用工具, 仅纯文本回复.";
    console.log(`Prompt: "${prompt1}"`);

    let snap1 = await bridge.sendPrompt({
      prompt: prompt1,
      model: "gpt-6.1-sol",
      waitMs: 15000,
    });

    console.log(`Turn 1 Initial State: ${snap1.state}, ThreadId: ${snap1.threadId}, TurnId: ${snap1.turnId}`);
    while (snap1.state === "running") {
      console.log(`Polling Turn 1 (attempt ${snap1.pollAttempt}, wait ${snap1.nextRecommendedWaitMs}ms)...`);
      snap1 = await bridge.pollTurn({
        threadId: snap1.threadId,
        turnId: snap1.turnId,
      });
    }

    console.log(`Turn 1 Final State: ${snap1.state}`);
    console.log(`Turn 1 Response: "${snap1.streamingText.trim()}"`);

    if (snap1.state !== "completed") {
      throw new Error(`Turn 1 failed to complete: state=${snap1.state}, error=${snap1.error}`);
    }

    const threadId = snap1.threadId;

    // Small pause to prevent 429 rate limit
    console.log("Waiting 3s before Turn 2 to avoid rate limit...");
    await new Promise((r) => setTimeout(r, 3000));

    // 3. Turn 2: Continue in same conversation
    console.log(`\n[3/4] Starting Turn 2 (Continuation in ${threadId})...`);
    const prompt2 = "请问在上一轮中你回复的具体文本是什么? 简短回答.";
    console.log(`Prompt: "${prompt2}"`);

    let snap2 = await bridge.sendPrompt({
      threadId,
      prompt: prompt2,
      model: "gpt-6.1-sol",
      waitMs: 15000,
    });

    console.log(`Turn 2 Initial State: ${snap2.state}, TurnId: ${snap2.turnId}`);
    while (snap2.state === "running") {
      console.log(`Polling Turn 2 (attempt ${snap2.pollAttempt}, wait ${snap2.nextRecommendedWaitMs}ms)...`);
      snap2 = await bridge.pollTurn({
        threadId: snap2.threadId,
        turnId: snap2.turnId,
      });
    }

    console.log(`Turn 2 Final State: ${snap2.state}`);
    console.log(`Turn 2 Response: "${snap2.streamingText.trim()}"`);

    if (snap2.state !== "completed") {
      throw new Error(`Turn 2 failed to complete: state=${snap2.state}, error=${snap2.error}`);
    }

    // 4. Verify session details
    console.log("\n[4/4] Reading Session Details...");
    const details = await bridge.listSessions({ threadId });
    console.log(`Session messages count: ${details.messages.length}`);
    for (const msg of details.messages) {
      console.log(`- [${msg.role}]: ${msg.text.slice(0, 50)}...`);
    }

    console.log("\n=== [Codex MCP Smoke Test] ALL CHECKS PASSED! ===");
  } finally {
    client.close();
  }
}

runSmoke().catch((err) => {
  console.error("\n[Codex MCP Smoke Test] Failed with error:", err);
  process.exit(1);
});
