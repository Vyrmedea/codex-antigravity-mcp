import readline from "node:readline";
import fs from "node:fs";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    process.stderr.write(`[fake-app-server] Invalid JSON: ${trimmed}\n`);
    return;
  }

  // Handle client responses to server requests
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    // Client answered a server request!
    process.stderr.write(`[fake-app-server] Received client response for ${msg.id}: ${JSON.stringify(msg)}\n`);
    send({
      method: "item/completed",
      params: { threadId: "fake-thread-1", turnId: "turn-1", itemId: "item-1" },
    });
    send({
      method: "turn/completed",
      params: { threadId: "fake-thread-1", turnId: "turn-1", status: "completed" },
    });
    return;
  }

  // Handle client notifications
  if (msg.method === "initialized") {
    process.stderr.write("[fake-app-server] Initialized notification received\n");
    return;
  }

  // Handle client requests
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        userAgent: "fake-codex-cli",
        codexHome: "D:/dummy",
        platformFamily: "windows",
        platformOs: "windows",
      },
    });
    return;
  }

  if (msg.method === "thread/start") {
    send({
      id: msg.id,
      result: {
        id: "fake-thread-1",
        thread: {
          id: "fake-thread-1",
          cwd: msg.params?.cwd || "D:/dummy-cwd",
          createdAt: 1000,
        },
      },
    });
    return;
  }

  if (msg.method === "thread/resume") {
    send({
      id: msg.id,
      result: {
        thread: {
          id: msg.params.threadId,
          cwd: msg.params?.cwd || "D:/resumed-cwd",
          createdAt: 1000,
        },
        cwd: msg.params?.cwd || "D:/resumed-cwd",
      },
    });
    return;
  }

  if (msg.method === "thread/list") {
    send({
      id: msg.id,
      result: {
        threads: [
          {
            id: "thread-abc",
            preview: "historical conversation",
            cwd: "D:/codex-data/考研",
            sourceKind: "cli",
            createdAt: 1234,
            updatedAt: 5678,
          },
        ],
        nextCursor: null,
        echoSourceKinds: msg.params?.sourceKinds,
      },
    });
    return;
  }

  if (msg.method === "thread/read") {
    send({
      id: msg.id,
      result: {
        thread: {
          id: msg.params.threadId,
          cwd: "D:/codex-data/考研",
          preview: "preview text",
          createdAt: 1234,
        },
        turns: [
          {
            id: "t-turn-1",
            items: [
              {
                type: "userMessage",
                content: [{ type: "text", text: "历史提问" }],
              },
              {
                type: "agentMessage",
                content: [{ type: "text", text: "历史回答" }],
              },
            ],
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "turn/start") {
    const promptText = msg.params?.input?.[0]?.text || "";
    const threadId = msg.params?.threadId || "fake-thread-1";
    const turnId = "turn-100";

    if (promptText.includes("die_exit")) {
      process.exit(1);
    }

    if (promptText.includes("close_stdout")) {
      process.exit(0);
    }

    send({
      id: msg.id,
      result: {
        turn: {
          id: turnId,
          status: "in_progress",
        },
      },
    });

    send({
      method: "turn/started",
      params: { threadId, turnId },
    });

    if (promptText.includes("trigger_command_approval")) {
      send({
        id: 9001,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: "cmd-item-1",
          command: "npm test",
          startedAtMs: Date.now(),
        },
      });
      return;
    }

    if (promptText.includes("trigger_resolved")) {
      send({
        id: 9002,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: "cmd-item-2",
          command: "echo test",
          startedAtMs: Date.now(),
        },
      });
      // Immediately resolve/cancel it from server side
      setTimeout(() => {
        send({
          method: "serverRequest/resolved",
          params: { threadId, requestId: 9002 },
        });
        send({
          method: "turn/completed",
          params: { threadId, turnId, status: "completed" },
        });
      }, 50);
      return;
    }

    if (promptText.includes("trigger_user_input")) {
      send({
        id: 9003,
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "input-item-1",
          questions: [{ id: "q1", question: "Continue?" }],
          isBlocking: true,
        },
      });
      return;
    }

    // Default: normal execution with streaming and completion
    send({
      method: "item/started",
      params: { threadId, turnId, itemId: "msg-1" },
    });
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "msg-1", delta: "Hello " },
    });
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "msg-1", delta: "World!" },
    });
    send({
      method: "item/completed",
      params: { threadId, turnId, itemId: "msg-1" },
    });
    send({
      method: "turn/completed",
      params: { threadId, turnId, status: "completed" },
    });
    return;
  }

  if (msg.method === "turn/interrupt") {
    send({
      id: msg.id,
      result: { ok: true },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: msg.params?.threadId,
        turnId: msg.params?.turnId,
        status: "interrupted",
      },
    });
    return;
  }

  // Fallback for unhandled methods
  send({
    id: msg.id,
    result: { receivedMethod: msg.method },
  });
});
