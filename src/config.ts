import { resolve } from "node:path";

export interface CodexMcpConfig {
  nodeExe: string;
  codexBin: string;
  defaultCwd: string;
  defaultPermissionMode: "supervised" | "full-access" | "read-only";
  safeTrashOnly: boolean;
  backoffScheduleMs: number[];
  maxWaitMs: number;
  interruptWaitMs: number;
  outputTailLimitBytes: number;
  developerInstructions: string;
}

function getDefaultCodexBin(): string {
  if (process.env.CODEX_BIN_PATH) {
    return process.env.CODEX_BIN_PATH;
  }
  return "codex";
}

export const DEFAULT_CONFIG: CodexMcpConfig = {
  nodeExe: process.env.CODEX_NODE_PATH || process.execPath || "node",
  codexBin: getDefaultCodexBin(),
  defaultCwd: process.env.CODEX_DEFAULT_CWD || process.cwd(),
  defaultPermissionMode: "supervised",
  safeTrashOnly: process.env.CODEX_SAFE_TRASH !== "false",
  backoffScheduleMs: [10000, 20000, 40000],
  maxWaitMs: 45000,
  interruptWaitMs: 5000,
  outputTailLimitBytes: 4096,
  developerInstructions: [
    "严格安全规则:",
    "1. 所有文件删除操作必须移动到垃圾箱, 绝对禁止直接执行删除 (rm / del / Remove-Item 无垃圾箱参数 等).",
    "2. 涉及删除行为的代码或操作均须遵守此项原则.",
  ].join("\n"),
};

export function resolveEffectiveCwd(
  explicitCwd?: string | null,
  cachedCwd?: string | null,
  fallbackCwd: string = DEFAULT_CONFIG.defaultCwd
): string {
  if (explicitCwd && explicitCwd.trim().length > 0) {
    return resolve(explicitCwd.trim());
  }
  if (cachedCwd && cachedCwd.trim().length > 0) {
    return resolve(cachedCwd.trim());
  }
  return resolve(fallbackCwd);
}
