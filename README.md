# Codex Antigravity MCP Server

> **"GPT不说人话、不背责任不粘锅而感觉每次对话都像在打卡上班？"**  
> **"Gemini满是活人感、但智商不太够导致完全不能用？"**  
>  
> 当然是选择让Gemini去拷打gpt了！

轻量级本地MCP服务, 将OpenAI Codex CLI(`codex app-server --listen stdio://`)桥接封装为Antigravity、Claude Desktop、Cursor等各类 Agent 宿主可直接调用的标准服务.

---

## 核心特性

- **原生历史会话续接与多轮上下文恢复 (`threadId`)**:
  - 直接复用 Codex 原生保存在 `~/.codex` 的会话持久化存储.
  - 通过 `sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"]` 跨越终端 CLI、VS Code 插件以及 MCP, 无缝列出并无损续接历史对话.
  - 支持向宿主 Agent 直接回显指定历史会话的消息摘要与上下文.

- **工作区目录与沙箱策略精准映射 (`effectiveCwd`)**:
  - 自动规范化解析 `effectiveCwd` (显式传入 -> 恢复会话目录 -> 默认工作区).
  - 将权限档位精确映射为底层 Codex 沙箱策略:
    - `supervised` (默认推荐): 工作区可写 (`writableRoots: [effectiveCwd]`), 网络禁用, 敏感操作与终端命令由宿主代理审批 (`on-request`).
    - `full-access`: 免审批完全访问 (`danger-full-access`).
    - `read-only`: 只读模式, 禁用写权限与网络访问.

- **截断指数退避长轮询 (`10s -> 20s -> 40s`, 上限 `45s`)**:
  - 任务执行中未决时自动递增等待窗口, 杜绝无效的密集高频空转.
  - 任务执行完成、触发反向审批或进程断线时**即刻唤醒返回**, 绝不无谓挂起.

- **反向代理审批闭环 (`InteractionBroker` + `codex_approve`)**:
  - 完整代理并转交 Codex 运行期的各项审批: 终端命令执行、文件变更、权限扩增以及交互提问 (`user_input`).
  - 实时监听服务端 `serverRequest/resolved` 通知, 杜绝重复提交或响应已失效审批.

- **安全防误删可选项 (`CODEX_SAFE_TRASH`)**:
  - 防御性拦截直接永久删除命令 (如 `rm -rf`, `del /f`, `Remove-Item` 等), 强制要求使用回收站/垃圾箱参数.
  - 支持通过环境变量 `CODEX_SAFE_TRASH=false` 全局关闭, 或在 `codex_send` 中传入 `safeTrashOnly: false` 进行单次覆盖.

- **实时状态聚合与命令尾部追踪 (`TurnTracker`)**:
  - 内存流式汇聚 Codex 回复文本.
  - 实时维护当前正在运行之终端命令的 4KiB UTF-8 滚动输出尾部 (`activeCommand`), 方便实时查看构建或测试动态.

---

## MCP 对外工具契约

| 工具名称 | 参数列表 | 功能说明 |
|---|---|---|
| `codex_send` | `prompt`: 提示词文本<br>`cwd?`: 工作目录 (省略时自动对齐)<br>`threadId?`: 历史会话 ID (省略时创建新会话)<br>`model?`: 指定模型<br>`effort?`: 推理深度 (low/medium/high)<br>`serviceTier?`: 速率模式 (default/priority)<br>`permissionMode?`: `"supervised" \| "full-access" \| "read-only"`<br>`safeTrashOnly?`: 是否强制仅移入垃圾箱 (默认遵循配置)<br>`waitMs?`: 初始等待毫秒数 (范围 0..45000, 默认 10000) | 启动新一轮任务执行. 若存在未结束任务则返回 `BUSY`. 初始窗口返回快照及下次建议轮询间隔. |
| `codex_poll` | `threadId`: 会话 ID<br>`turnId`: 轮次 ID<br>`cursor?`: 事件游标 (默认 0)<br>`waitMs?`: 自定义等待毫秒数 (省略时按退避表自动等待) | 轮询当前运行中任务的最新进展. 任务完成、审批触发或超时后唤醒返回. |
| `codex_approve` | `threadId`: 会话 ID<br>`turnId`: 轮次 ID<br>`interactionId`: 审批请求 ID (从快照中获取)<br>`decision`: `"accept" \| "decline" \| "cancel"`<br>`answers?`: 交互提问键值对<br>`waitMs?`: 审批后等待毫秒数 (默认 10000) | 回复 Codex 执行期的反向审批请求, 自动根据安全配置拦截危险删除命令. |
| `codex_cancel` | `threadId`: 会话 ID<br>`turnId`: 轮次 ID | 中断正在执行的任务, 发送 `turn/interrupt` 并等待终态确认. |
| `codex_sessions` | `cwd?`: 按工作区筛选<br>`threadId?`: 指定会话 ID<br>`limit?`: 数量上限 (默认 20) | 省略 `threadId` 时列出所有历史会话; 传入 `threadId` 时读取该会话的历史对话详情. |

---

## 环境变量说明

| 环境变量 | 默认值 | 作用说明 |
|---|---|---|
| `CODEX_BIN_PATH` | `codex` | Codex CLI 执行文件路径 (支持系统 PATH 中的 `codex`, 或 `codex.exe` / `codex.js` 的绝对路径). |
| `CODEX_NODE_PATH` | `node` / `process.execPath` | 运行入口为 JS 脚本时所调用的 Node.js 可执行文件路径. |
| `CODEX_DEFAULT_CWD` | `process.cwd()` | 当请求与续接会话均未指定目录时的默认回退工作区. |
| `CODEX_SAFE_TRASH` | `true` | 是否全局强制启用"仅移动到垃圾箱"安全拦截规则, 设置为 `false` 可解除限制. |

---

## 快速上手

### 1. 前置依赖

- [Node.js](https://nodejs.org/) >= 18.0.0
- [OpenAI Codex CLI](https://github.com/openai/codex) 已安装并完成登录授权

### 2. 安装与构建

```bash
git clone https://github.com/<你的用户名>/codex-antigravity-mcp.git
cd codex-antigravity-mcp

# 安装依赖
npm install

# 编译 TypeScript 至 dist/
npm run build

# 运行自动化测试套件 (17 个用例全部通过)
npm test
```

### 3. 配置接入示例

#### Antigravity 配置

在 Antigravity 的 MCP 配置文件中加入:

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": [
        "<你的项目绝对路径>/dist/index.js"
      ],
      "env": {
        "CODEX_BIN_PATH": "codex",
        "CODEX_SAFE_TRASH": "true"
      }
    }
  }
}
```

#### Claude Desktop 配置

在 `claude_desktop_config.json` 中配置:

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": [
        "<你的项目绝对路径>/dist/index.js"
      ]
    }
  }
}
```

---

## 开发与验证

```bash
# 纯类型检查 (不输出文件)
npm run typecheck

# 依据本机安装的 Codex app-server 重新生成 TypeScript 协议类型
npm run protocol:generate

# 运行单元与集成测试 (内置 fake-app-server 双向测试)
npm test

# 运行真实环境两轮长对话冒烟验收
node scripts/smoke.mjs
```

---

## 开源协议

本项目采用 [MIT](LICENSE) 协议开源.
