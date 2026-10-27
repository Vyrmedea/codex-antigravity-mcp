import { DEFAULT_CONFIG, resolveEffectiveCwd } from "../config.js";
import {
  ApprovalDecision,
  ApprovalKind,
  PermissionMode,
} from "../types.js";
import { JsonRpcConnection, JsonRpcNotification, JsonRpcRequest } from "./jsonrpc.js";
import type { InitializeParams } from "./protocol/InitializeParams.js";
import type { InitializeResponse } from "./protocol/InitializeResponse.js";
import type { AskForApproval } from "./protocol/v2/AskForApproval.js";
import type { SandboxMode } from "./protocol/v2/SandboxMode.js";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.js";
import type { ThreadListParams } from "./protocol/v2/ThreadListParams.js";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.js";
import type { TurnInterruptParams } from "./protocol/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.js";

export interface StartThreadOptions {
  cwd?: string;
  permissionMode?: PermissionMode;
  safeTrashOnly?: boolean;
  model?: string;
  serviceTier?: string;
}

export interface ResumeThreadOptions {
  threadId: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  safeTrashOnly?: boolean;
  model?: string;
}

export interface ListThreadsOptions {
  cwd?: string;
  limit?: number;
  cursor?: string;
}

export interface StartTurnOptions {
  threadId: string;
  prompt: string;
  effectiveCwd: string;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: string;
  serviceTier?: string;
}

export class CodexClient {
  private connection: JsonRpcConnection | null = null;
  private connectingPromise: Promise<void> | null = null;

  private notificationListeners = new Set<(notif: JsonRpcNotification) => void>();
  private serverRequestListeners = new Set<(req: JsonRpcRequest) => void>();
  private disconnectListeners = new Set<(err: Error) => void>();

  constructor(
    private readonly nodeExe: string = DEFAULT_CONFIG.nodeExe,
    private readonly codexBin: string = DEFAULT_CONFIG.codexBin,
    private readonly defaultCwd: string = DEFAULT_CONFIG.defaultCwd
  ) {}

  public onNotification(cb: (notif: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(cb);
    return () => this.notificationListeners.delete(cb);
  }

  public onServerRequest(cb: (req: JsonRpcRequest) => void): () => void {
    this.serverRequestListeners.add(cb);
    return () => this.serverRequestListeners.delete(cb);
  }

  public onDisconnect(cb: (err: Error) => void): () => void {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  public isConnected(): boolean {
    return this.connection !== null && !this.connection.closed;
  }

  public async ensureConnected(): Promise<void> {
    if (this.isConnected()) {
      return;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = (async () => {
      try {
        if (this.connection) {
          this.connection.close();
          this.connection = null;
        }

        const isDirectExe = this.codexBin.toLowerCase().endsWith(".exe");
        const spawnCmd = isDirectExe ? this.codexBin : this.nodeExe;
        const spawnArgs = isDirectExe
          ? ["app-server", "--listen", "stdio://"]
          : [this.codexBin, "app-server", "--listen", "stdio://"];

        const conn = new JsonRpcConnection(
          spawnCmd,
          spawnArgs,
          this.defaultCwd,
          {
            onNotification: (notif) => {
              for (const listener of this.notificationListeners) {
                try {
                  listener(notif);
                } catch (e) {
                  console.error("[CodexClient] Error in notification listener:", e);
                }
              }
            },
            onServerRequest: (req) => {
              for (const listener of this.serverRequestListeners) {
                try {
                  listener(req);
                } catch (e) {
                  console.error("[CodexClient] Error in serverRequest listener:", e);
                }
              }
            },
            onDisconnect: (err) => {
              this.connection = null;
              for (const listener of this.disconnectListeners) {
                try {
                  listener(err);
                } catch (e) {
                  console.error("[CodexClient] Error in disconnect listener:", e);
                }
              }
            },
            onStderr: (chunk) => {
              // Log diagnostic messages to process stderr
              process.stderr.write(`[CodexServer stderr] ${chunk}`);
            },
          }
        );

        conn.start();
        this.connection = conn;

        const initParams: InitializeParams = {
          clientInfo: {
            name: "antigravity-codex-mcp",
            title: "Codex MCP Bridge",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
          },
        };

        await conn.request<InitializeResponse>("initialize", initParams);
        conn.notify("initialized");
      } finally {
        this.connectingPromise = null;
      }
    })();

    return this.connectingPromise;
  }

  public async startThread(options: StartThreadOptions = {}): Promise<any> {
    await this.ensureConnected();
    const mode = options.permissionMode || DEFAULT_CONFIG.defaultPermissionMode;
    const { sandbox, approvalPolicy } = this.mapThreadPermissionMode(mode);
    const cwd = options.cwd ? resolveEffectiveCwd(options.cwd) : undefined;
    const safeTrash =
      options.safeTrashOnly !== undefined
        ? options.safeTrashOnly
        : DEFAULT_CONFIG.safeTrashOnly;
    const developerInstructions = safeTrash
      ? DEFAULT_CONFIG.developerInstructions
      : undefined;

    const params: ThreadStartParams = {
      cwd,
      sandbox,
      approvalPolicy,
      developerInstructions,
      model: options.model,
      serviceTier: options.serviceTier,
    };

    const res = await this.connection!.request<any>("thread/start", params);
    return res;
  }

  public async resumeThread(options: ResumeThreadOptions): Promise<ThreadResumeResponse> {
    await this.ensureConnected();
    const mode = options.permissionMode || DEFAULT_CONFIG.defaultPermissionMode;
    const { sandbox, approvalPolicy } = this.mapThreadPermissionMode(mode);
    const cwd = options.cwd ? resolveEffectiveCwd(options.cwd) : undefined;
    const safeTrash =
      options.safeTrashOnly !== undefined
        ? options.safeTrashOnly
        : DEFAULT_CONFIG.safeTrashOnly;
    const developerInstructions = safeTrash
      ? DEFAULT_CONFIG.developerInstructions
      : undefined;

    const params: ThreadResumeParams = {
      threadId: options.threadId,
      cwd,
      sandbox,
      approvalPolicy,
      developerInstructions,
      model: options.model,
      excludeTurns: true,
    };

    return await this.connection!.request<ThreadResumeResponse>("thread/resume", params);
  }

  public async listThreads(options: ListThreadsOptions = {}): Promise<any> {
    await this.ensureConnected();
    const params: ThreadListParams = {
      cwd: options.cwd ? resolveEffectiveCwd(options.cwd) : undefined,
      limit: options.limit ?? 20,
      cursor: options.cursor,
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
    };

    return await this.connection!.request<any>("thread/list", params);
  }

  public async readThread(threadId: string, includeTurns = true): Promise<any> {
    await this.ensureConnected();
    return await this.connection!.request<any>("thread/read", {
      threadId,
      includeTurns,
    });
  }

  public async startTurn(options: StartTurnOptions): Promise<any> {
    await this.ensureConnected();
    const mode = options.permissionMode || DEFAULT_CONFIG.defaultPermissionMode;
    const { sandboxPolicy, approvalPolicy } = this.mapTurnPermissionMode(
      mode,
      options.effectiveCwd
    );

    const params: TurnStartParams = {
      threadId: options.threadId,
      input: [
        {
          type: "text",
          text: options.prompt,
          text_elements: [],
        },
      ],
      cwd: options.effectiveCwd,
      sandboxPolicy,
      approvalPolicy,
      model: options.model,
      effort: options.effort,
      serviceTier: options.serviceTier,
    };

    return await this.connection!.request<any>("turn/start", params);
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<any> {
    if (!this.isConnected()) {
      return;
    }
    const params: TurnInterruptParams = {
      threadId,
      turnId,
    };
    return await this.connection!.request<any>("turn/interrupt", params);
  }

  public respondApproval(
    id: number | string,
    kind: ApprovalKind,
    decision: ApprovalDecision,
    extra?: {
      answers?: Record<string, string | string[]>;
      permissions?: any;
    }
  ): void {
    if (!this.connection || this.connection.closed) {
      return;
    }

    switch (kind) {
      case "command_approval":
      case "file_approval": {
        this.connection.respond(id, { decision });
        break;
      }
      case "permission_approval": {
        if (decision === "accept") {
          this.connection.respond(id, {
            permissions: extra?.permissions ?? {},
            scope: "turn",
          });
        } else {
          this.connection.respond(id, {
            permissions: {},
            scope: "turn",
          });
        }
        break;
      }
      case "user_input": {
        if (decision === "accept") {
          const raw = extra?.answers ?? {};
          const formattedAnswers: Record<string, { answers: string[] }> = {};
          for (const [key, value] of Object.entries(raw)) {
            const arr = Array.isArray(value) ? value : [String(value)];
            formattedAnswers[key] = { answers: arr };
          }
          this.connection.respond(id, { answers: formattedAnswers });
        } else {
          this.connection.respond(id, { answers: {} });
        }
        break;
      }
    }
  }

  public close(): void {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
  }

  private mapThreadPermissionMode(mode: PermissionMode): {
    sandbox: SandboxMode;
    approvalPolicy: AskForApproval;
  } {
    switch (mode) {
      case "full-access":
        return {
          sandbox: "danger-full-access",
          approvalPolicy: "never",
        };
      case "read-only":
        return {
          sandbox: "read-only",
          approvalPolicy: "on-request",
        };
      case "supervised":
      default:
        return {
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
        };
    }
  }

  private mapTurnPermissionMode(
    mode: PermissionMode,
    effectiveCwd: string
  ): {
    sandboxPolicy: SandboxPolicy;
    approvalPolicy: AskForApproval;
  } {
    switch (mode) {
      case "full-access":
        return {
          sandboxPolicy: { type: "dangerFullAccess" },
          approvalPolicy: "never",
        };
      case "read-only":
        return {
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          approvalPolicy: "on-request",
        };
      case "supervised":
      default:
        return {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [effectiveCwd],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          approvalPolicy: "on-request",
        };
    }
  }
}
