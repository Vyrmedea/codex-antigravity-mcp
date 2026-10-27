#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CodexClient } from "./codex/client.js";
import { DEFAULT_CONFIG } from "./config.js";
import { BridgeService } from "./core/bridge.js";
import { createMcpServer } from "./mcp/server.js";

async function main() {
  process.stderr.write("[codex-mcp] Starting Codex Antigravity MCP Server...\n");

  const client = new CodexClient(
    DEFAULT_CONFIG.nodeExe,
    DEFAULT_CONFIG.codexBin,
    DEFAULT_CONFIG.defaultCwd
  );
  const bridge = new BridgeService(client);
  const server = createMcpServer(bridge);

  const transport = new StdioServerTransport();

  const shutdown = () => {
    process.stderr.write("[codex-mcp] Shutting down...\n");
    client.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  process.stderr.write("[codex-mcp] Codex Antigravity MCP Server running on stdio.\n");
}

main().catch((err) => {
  process.stderr.write(`[codex-mcp] Fatal error: ${err.message || err}\n`);
  process.exit(1);
});
