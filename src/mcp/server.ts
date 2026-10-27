import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeService } from "../core/bridge.js";

export function createMcpServer(bridge: BridgeService): McpServer {
  const server = new McpServer({
    name: "codex-bridge",
    version: "0.1.0",
  });

  server.tool(
    "codex_send",
    "向 Codex 发送提示词 (支持新建会话或在已有 threadId 上继续对话). 支持设置工作区目录、模型和权限模式. 在初始窗口 (默认 10s) 内等待, 若未完成则返回快照及下一次轮询的推荐退避时间.",
    {
      prompt: z.string().describe("用户发送给 Codex 的提示词文本"),
      cwd: z.string().optional().describe("工作目录 (绝对路径或相对路径, 省略时自动对齐会话目录或默认考研目录)"),
      threadId: z.string().optional().describe("已有会话 ID, 传入时续接该会话历史上下文"),
      model: z.string().optional().describe("Codex 使用的模型 (如 gpt-4o, o3-mini 等, 省略时遵循默认配置)"),
      effort: z.string().optional().describe("推理深度 (low, medium, high 等, 省略时遵循默认配置)"),
      serviceTier: z.string().optional().describe("服务速率模式 (default 标准速度, priority 优先加速 Fast)"),
      permissionMode: z
        .enum(["supervised", "full-access", "read-only"])
        .optional()
        .describe("权限模式: supervised (默认工作区可写+反向审批), full-access (完全访问), read-only (只读)"),
      safeTrashOnly: z
        .boolean()
        .optional()
        .describe("是否启用仅移入垃圾箱的安全规则 (默认遵循配置或环境变量 CODEX_SAFE_TRASH)"),
      waitMs: z
        .number()
        .min(0)
        .max(45000)
        .optional()
        .describe("本轮调用等待时长 (毫秒, 范围 0..45000, 默认 10000)"),
    },
    async (args) => {
      try {
        const result = await bridge.sendPrompt({
          prompt: args.prompt,
          cwd: args.cwd,
          threadId: args.threadId,
          model: args.model,
          effort: args.effort,
          serviceTier: args.serviceTier,
          permissionMode: args.permissionMode,
          safeTrashOnly: args.safeTrashOnly,
          waitMs: args.waitMs,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message || String(err) }],
        };
      }
    }
  );

  server.tool(
    "codex_poll",
    "轮询当前运行中的 Codex 任务进度. 未传 waitMs 时自动按截断指数退避 (20s -> 40s) 等待. 当任务完成、触发审批或断线时立刻返回.",
    {
      threadId: z.string().describe("会话 ID"),
      turnId: z.string().describe("轮次 ID"),
      cursor: z.number().optional().describe("事件游标 (由上一次快照返回, 默认 0)"),
      waitMs: z
        .number()
        .min(0)
        .max(45000)
        .optional()
        .describe("自定义等待毫秒数 (范围 0..45000, 省略时自动退避)"),
    },
    async (args) => {
      try {
        const result = await bridge.pollTurn({
          threadId: args.threadId,
          turnId: args.turnId,
          cursor: args.cursor,
          waitMs: args.waitMs,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message || String(err) }],
        };
      }
    }
  );

  server.tool(
    "codex_approve",
    "回复 Codex 的反向审批请求 (命令执行、文件更改、权限申请或用户交互提问). 会自动拦截危险的直接删除命令并转为 decline.",
    {
      threadId: z.string().describe("会话 ID"),
      turnId: z.string().describe("轮次 ID"),
      interactionId: z.string().describe("待审批项的 interactionId (从快照 pendingApproval 获取)"),
      decision: z.enum(["accept", "decline", "cancel"]).describe("决策: accept, decline 或 cancel"),
      answers: z
        .record(z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe("针对 user_input 类型的问题回答字典 Record<questionId, answer>"),
      waitMs: z
        .number()
        .min(0)
        .max(45000)
        .optional()
        .describe("审批后等待时长 (毫秒, 范围 0..45000, 默认 10000)"),
    },
    async (args) => {
      try {
        const result = await bridge.approveTurn({
          threadId: args.threadId,
          turnId: args.turnId,
          interactionId: args.interactionId,
          decision: args.decision,
          answers: args.answers,
          waitMs: args.waitMs,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message || String(err) }],
        };
      }
    }
  );

  server.tool(
    "codex_cancel",
    "取消当前运行中的 Codex 执行轮次. 发送中断指令并等待最多 5 秒确认. 在旧命令确认停止前保持忙碌状态以防止并发写冲突.",
    {
      threadId: z.string().describe("会话 ID"),
      turnId: z.string().describe("轮次 ID"),
    },
    async (args) => {
      try {
        const result = await bridge.cancelTurn({
          threadId: args.threadId,
          turnId: args.turnId,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message || String(err) }],
        };
      }
    }
  );

  server.tool(
    "codex_sessions",
    "查看本地 Codex 原生历史会话列表或指定会话的历史对话详情. 支持覆盖全来源 (CLI / VS Code / 桌面端 / exec / appServer).",
    {
      cwd: z.string().optional().describe("按项目目录筛选会话"),
      threadId: z.string().optional().describe("指定会话 ID 时, 读取并返回该会话的元数据及历史消息摘要"),
      limit: z.number().min(1).max(100).optional().describe("返回会话数量上限 (默认 20)"),
    },
    async (args) => {
      try {
        const result = await bridge.listSessions({
          cwd: args.cwd,
          threadId: args.threadId,
          limit: args.limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: err.message || String(err) }],
        };
      }
    }
  );

  return server;
}
