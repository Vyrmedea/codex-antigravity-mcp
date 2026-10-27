import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const outDir = resolve(projectRoot, "src/codex/protocol");

const nodeExe = process.env.CODEX_NODE_PATH || process.execPath || "node";
const codexJs = process.env.CODEX_BIN_PATH || "codex";

console.log(`[generate-protocol] Generating protocol types to ${outDir}...`);

const res = spawnSync(nodeExe, [codexJs, "app-server", "generate-ts", "--out", outDir], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

if (res.error) {
  console.error("[generate-protocol] Execution failed:", res.error);
  process.exit(1);
}

if (res.status !== 0) {
  console.error(`[generate-protocol] Codex exited with code ${res.status}`);
  process.exit(res.status || 1);
}

console.log("[generate-protocol] Done.");
