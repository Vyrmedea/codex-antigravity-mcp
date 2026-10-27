import { CodexClient } from "../codex/client.js";
import { DEFAULT_CONFIG, resolveEffectiveCwd } from "../config.js";
import { InteractionBroker } from "../interactions/broker.js";
import {
  ApprovalDecision,
  PermissionMode,
  SessionDetails,
  SessionSummary,
  TurnResultSnapshot,
} from "../types.js";
import { SessionRegistry } from "./session-registry.js";
import { TurnTracker } from "./turn-tracker.js";

export interface SendPromptOptions {
  prompt: string;
  cwd?: string;
  threadId?: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
  permissionMode?: PermissionMode;
  safeTrashOnly?: boolean;
  waitMs?: number;
}

export interface PollTurnOptions {
  threadId: string;
  turnId: string;
  cursor?: number;
  waitMs?: number;
}

export interface ApproveTurnOptions {
  threadId: string;
  turnId: string;
  interactionId: string;
  decision: ApprovalDecision;
  answers?: Record<string, string | string[]>;
  waitMs?: number;
}

export interface CancelTurnOptions {
  threadId: string;
  turnId: string;
}

export interface ListSessionsOptions {
  cwd?: string;
  threadId?: string;
  limit?: number;
}

export class BridgeService {
  private activeTracker: TurnTracker | null = null;
  private lastTracker: TurnTracker | null = null;

  constructor(
    public readonly client: CodexClient,
    public readonly broker: InteractionBroker = new InteractionBroker(),
    public readonly sessions: SessionRegistry = new SessionRegistry()
  ) {
    this.setupListeners();
  }

  private setupListeners(): void {
    this.client.onNotification((notif) => {
      this.handleNotification(notif.method, notif.params as any);
    });

    this.client.onServerRequest((req) => {
      this.handleServerRequest(req);
    });

    this.client.onDisconnect((err) => {
      this.handleDisconnect(err);
    });
  }

  private handleNotification(method: string, params: any): void {
    const threadId = params?.threadId;
    const turnId = params?.turnId;

    if (!this.activeTracker || this.activeTracker.threadId !== threadId) {
      return;
    }

    switch (method) {
      case "turn/started": {
        if (params?.turnId) {
          this.activeTracker.turnId = params.turnId;
        }
        this.activeTracker.setState("running");
        break;
      }
      case "turn/completed": {
        const status = params?.status || "completed";
        this.activeTracker.handleTurnCompleted(status);
        this.lastTracker = this.activeTracker;
        this.activeTracker = null;
        break;
      }
      case "item/started": {
        const item = params?.item || {};
        this.activeTracker.handleItemStarted(params?.itemId || item.id, item.type, item);
        break;
      }
      case "item/completed": {
        const item = params?.item || {};
        this.activeTracker.handleItemCompleted(params?.itemId || item.id);
        break;
      }
      case "item/agentMessage/delta": {
        const delta = params?.delta || "";
        this.activeTracker.appendStreamingText(delta);
        break;
      }
      case "item/commandExecution/outputDelta": {
        const delta = params?.delta || "";
        this.activeTracker.handleCommandOutputDelta(params?.itemId, delta);
        break;
      }
      case "turn/plan/updated": {
        this.activeTracker.recordPlanUpdated("Plan updated");
        break;
      }
      case "serverRequest/resolved": {
        const reqId = params?.requestId;
        if (reqId !== undefined) {
          const idStr = String(reqId);
          this.broker.markResolved(idStr);
          if (this.activeTracker.getPendingApproval()?.interactionId === idStr) {
            this.activeTracker.setPendingApproval(null);
          }
        }
        break;
      }
      case "error": {
        const msg = params?.message || JSON.stringify(params);
        this.activeTracker.handleTurnFailed(msg);
        this.lastTracker = this.activeTracker;
        this.activeTracker = null;
        break;
      }
    }
  }

  private handleServerRequest(req: any): void {
    const approval = this.broker.registerRequest(req);
    if (!approval) return;

    if (
      this.activeTracker &&
      (!approval.threadId || approval.threadId === this.activeTracker.threadId)
    ) {
      this.activeTracker.setPendingApproval(approval);
    }
  }

  private handleDisconnect(err: Error): void {
    if (this.activeTracker) {
      this.activeTracker.handleTurnFailed(`Codex backend disconnected: ${err.message}`);
      this.lastTracker = this.activeTracker;
      this.activeTracker = null;
    }
    this.broker.clear();
    this.sessions.clearLoaded();
  }

  public async sendPrompt(options: SendPromptOptions): Promise<TurnResultSnapshot> {
    if (this.activeTracker) {
      const state = this.activeTracker.getState();
      if (state === "running" || state === "waiting_approval" || state === "cancelling") {
        throw new Error(
          `BUSY: Another turn (${this.activeTracker.turnId}) is currently active (state: ${state})`
        );
      }
    }

    const permissionMode = options.permissionMode || DEFAULT_CONFIG.defaultPermissionMode;
    const safeTrashOnly =
      options.safeTrashOnly !== undefined
        ? options.safeTrashOnly
        : DEFAULT_CONFIG.safeTrashOnly;
    let effectiveThreadId = options.threadId;
    let effectiveCwd: string;

    const explicitCwd =
      options.cwd && options.cwd.trim().length > 0
        ? resolveEffectiveCwd(options.cwd)
        : undefined;

    if (effectiveThreadId) {
      if (!this.sessions.isLoaded(effectiveThreadId)) {
        const resumed = await this.client.resumeThread({
          threadId: effectiveThreadId,
          cwd: explicitCwd,
          permissionMode,
          safeTrashOnly,
          model: options.model,
        });
        effectiveCwd =
          explicitCwd || resolveEffectiveCwd(resumed.cwd || resumed.thread?.cwd);
        this.sessions.registerLoadedThread(effectiveThreadId, effectiveCwd);
      } else {
        effectiveCwd = explicitCwd || this.sessions.getCwd(effectiveThreadId)!;
        if (explicitCwd) {
          this.sessions.registerLoadedThread(effectiveThreadId, explicitCwd);
        }
      }
    } else {
      effectiveCwd = explicitCwd || resolveEffectiveCwd(null);
      const created = await this.client.startThread({
        cwd: effectiveCwd,
        permissionMode,
        safeTrashOnly,
        model: options.model,
      });
      effectiveThreadId = created.thread?.id || created.id;
      this.sessions.registerLoadedThread(effectiveThreadId!, effectiveCwd);
    }

    const tracker = new TurnTracker(effectiveThreadId!, "pending");
    tracker.safeTrashOnly = safeTrashOnly;
    this.activeTracker = tracker;

    try {
      const turnRes = await this.client.startTurn({
        threadId: effectiveThreadId!,
        prompt: options.prompt,
        effectiveCwd,
        permissionMode,
        model: options.model,
        effort: options.effort,
        serviceTier: options.serviceTier,
      });

      if (turnRes.turn?.id) {
        tracker.turnId = turnRes.turn.id;
      }
    } catch (err) {
      this.activeTracker = null;
      throw err;
    }

    // Wait initial backoff window (10s by default)
    const initialWaitMs = options.waitMs !== undefined ? options.waitMs : 10000;
    return await tracker.waitForSettleOrTimeout(initialWaitMs);
  }

  public async pollTurn(options: PollTurnOptions): Promise<TurnResultSnapshot> {
    const tracker = this.findTracker(options.threadId, options.turnId);
    if (!tracker) {
      throw new Error(
        `STALE_TURN: No active or recent turn matching threadId=${options.threadId}, turnId=${options.turnId}`
      );
    }

    tracker.incrementPollAttempt();
    return await tracker.waitForSettleOrTimeout(options.waitMs);
  }

  public async approveTurn(options: ApproveTurnOptions): Promise<TurnResultSnapshot> {
    const tracker = this.findTracker(options.threadId, options.turnId);
    if (!tracker) {
      throw new Error(
        `STALE_TURN: No active or recent turn matching threadId=${options.threadId}, turnId=${options.turnId}`
      );
    }

    const pending = this.broker.takePending(options.interactionId);
    if (!pending) {
      throw new Error(
        `INVALID_INTERACTION: Interaction ${options.interactionId} not found or already resolved`
      );
    }

    let decision = options.decision;

    // Safety guard against direct file deletions (if safeTrashOnly enabled)
    const shouldEnforceTrash = tracker.safeTrashOnly ?? DEFAULT_CONFIG.safeTrashOnly;
    if (shouldEnforceTrash && decision === "accept" && pending.kind === "command_approval") {
      const cmd = String(pending.details?.command || "").toLowerCase();
      const dangerousPatterns = [
        /\brm\s+-rf\b/,
        /\bdel\s+\/[sfq]\b/,
        /\bremove-item\b(?!.*-recycle)/,
        /\brmdir\s+\/s\b/,
      ];
      if (dangerousPatterns.some((p) => p.test(cmd))) {
        decision = "decline";
      }
    }

    this.client.respondApproval(pending.interactionId, pending.kind, decision, {
      answers: options.answers,
      permissions: pending.details?.permissions,
    });

    if (pending.kind === "user_input" && decision !== "accept") {
      await this.client.interruptTurn(options.threadId, options.turnId);
    }

    tracker.setPendingApproval(null);
    tracker.resetPollAttempt();

    const waitMs = options.waitMs !== undefined ? options.waitMs : 10000;
    return await tracker.waitForSettleOrTimeout(waitMs);
  }

  public async cancelTurn(options: CancelTurnOptions): Promise<TurnResultSnapshot> {
    const tracker = this.findTracker(options.threadId, options.turnId);
    if (!tracker) {
      throw new Error(
        `STALE_TURN: No active or recent turn matching threadId=${options.threadId}, turnId=${options.turnId}`
      );
    }

    if (tracker.isSettled()) {
      return tracker.getSnapshot();
    }

    tracker.setState("cancelling");
    this.broker.clear();

    await this.client.interruptTurn(options.threadId, options.turnId);

    // Wait up to interrupt timeout (5000ms) for turn/completed
    const snapshot = await tracker.waitForSettleOrTimeout(DEFAULT_CONFIG.interruptWaitMs);

    if (tracker.isSettled()) {
      if (this.activeTracker === tracker) {
        this.lastTracker = tracker;
        this.activeTracker = null;
      }
    }
    // If not settled after 5000ms, activeTracker remains set (state: cancelling) to prevent concurrent operations

    return snapshot;
  }

  public async listSessions(
    options: ListSessionsOptions = {}
  ): Promise<SessionSummary[] | SessionDetails> {
    if (options.threadId) {
      const readRes = await this.client.readThread(options.threadId, true);
      return this.sessions.parseSessionDetails(readRes);
    }

    const listRes = await this.client.listThreads({
      cwd: options.cwd,
      limit: options.limit ?? 20,
    });
    const rawList = Array.isArray(listRes?.data)
      ? listRes.data
      : Array.isArray(listRes?.threads)
      ? listRes.threads
      : [];
    return this.sessions.parseSessionSummaries(rawList);
  }

  private findTracker(threadId: string, turnId: string): TurnTracker | null {
    if (
      this.activeTracker &&
      this.activeTracker.threadId === threadId &&
      this.activeTracker.turnId === turnId
    ) {
      return this.activeTracker;
    }
    if (
      this.lastTracker &&
      this.lastTracker.threadId === threadId &&
      this.lastTracker.turnId === turnId
    ) {
      return this.lastTracker;
    }
    return null;
  }
}
