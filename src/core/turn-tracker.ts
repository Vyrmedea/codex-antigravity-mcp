import { DEFAULT_CONFIG } from "../config.js";
import {
  ActiveCommandSnapshot,
  PendingApproval,
  TurnEventSnapshot,
  TurnResultSnapshot,
  TurnState,
} from "../types.js";

export class TurnTracker {
  public readonly threadId: string;
  public turnId: string;
  public safeTrashOnly: boolean = DEFAULT_CONFIG.safeTrashOnly;

  private state: TurnState = "running";
  private streamingText = "";
  private activeCommand: ActiveCommandSnapshot | null = null;
  private pendingApproval: PendingApproval | null = null;
  private events: TurnEventSnapshot[] = [];
  private errorMessage: string | null = null;
  private pollAttempt = 0;

  private settleResolvers = new Set<() => void>();

  constructor(threadId: string, turnId: string) {
    this.threadId = threadId;
    this.turnId = turnId;
  }

  public getState(): TurnState {
    return this.state;
  }

  public setState(state: TurnState): void {
    if (this.state === state) return;
    this.state = state;
    this.wakeWaiters();
  }

  public setPendingApproval(approval: PendingApproval | null): void {
    this.pendingApproval = approval;
    if (approval) {
      this.setState("waiting_approval");
    } else if (this.state === "waiting_approval") {
      this.setState("running");
    }
    this.wakeWaiters();
  }

  public getPendingApproval(): PendingApproval | null {
    return this.pendingApproval;
  }

  public appendStreamingText(delta: string): void {
    this.streamingText += delta;
  }

  public handleItemStarted(itemId: string, itemType?: string, details?: Record<string, any>): void {
    if (itemType === "agentMessage" && this.streamingText.length > 0 && !this.streamingText.endsWith("\n")) {
      this.streamingText += "\n\n";
    }
    this.addEvent({
      id: itemId,
      kind: "item_started",
      message: `Item started: ${itemType || "item"}`,
      timestamp: Date.now(),
    });

    if (itemType === "commandExecution" || details?.command) {
      this.activeCommand = {
        itemId,
        command: details?.command || "",
        outputTail: "",
      };
    }
  }

  public handleCommandOutputDelta(itemId: string, delta: string): void {
    if (!this.activeCommand || this.activeCommand.itemId !== itemId) {
      this.activeCommand = {
        itemId,
        command: "",
        outputTail: "",
      };
    }

    const combined = this.activeCommand.outputTail + delta;
    const buf = Buffer.from(combined, "utf8");
    if (buf.length > DEFAULT_CONFIG.outputTailLimitBytes) {
      const slicedBuf = buf.subarray(buf.length - DEFAULT_CONFIG.outputTailLimitBytes);
      this.activeCommand.outputTail = slicedBuf.toString("utf8");
    } else {
      this.activeCommand.outputTail = combined;
    }
  }

  public handleItemCompleted(itemId: string): void {
    this.addEvent({
      id: itemId,
      kind: "item_completed",
      message: `Item completed: ${itemId}`,
      timestamp: Date.now(),
    });

    if (this.activeCommand && this.activeCommand.itemId === itemId) {
      this.activeCommand = null;
    }
  }

  public handleTurnCompleted(status: string): void {
    if (status === "interrupted") {
      this.state = "interrupted";
    } else if (status === "failed") {
      this.state = "failed";
    } else {
      this.state = "completed";
    }
    this.activeCommand = null;
    this.pendingApproval = null;
    this.wakeWaiters();
  }

  public handleTurnFailed(error: string): void {
    this.state = "failed";
    this.errorMessage = error;
    this.activeCommand = null;
    this.pendingApproval = null;
    this.addEvent({
      id: `err-${Date.now()}`,
      kind: "error",
      message: error,
      timestamp: Date.now(),
    });
    this.wakeWaiters();
  }

  public addEvent(event: TurnEventSnapshot): void {
    this.events.push(event);
  }

  public recordPlanUpdated(message: string): void {
    this.addEvent({
      id: `plan-${Date.now()}`,
      kind: "plan_updated",
      message,
      timestamp: Date.now(),
    });
  }

  public incrementPollAttempt(): void {
    this.pollAttempt++;
  }

  public resetPollAttempt(): void {
    this.pollAttempt = 0;
  }

  public getRecommendedWaitMs(): number {
    const schedule = DEFAULT_CONFIG.backoffScheduleMs;
    const idx = Math.min(this.pollAttempt, schedule.length - 1);
    const scheduled = schedule[idx];
    return Math.min(scheduled, DEFAULT_CONFIG.maxWaitMs);
  }

  public isSettled(): boolean {
    return (
      this.state === "completed" ||
      this.state === "failed" ||
      this.state === "interrupted" ||
      this.state === "waiting_approval"
    );
  }

  public async waitForSettleOrTimeout(requestedWaitMs?: number): Promise<TurnResultSnapshot> {
    if (this.isSettled()) {
      return this.getSnapshot();
    }

    const waitMs =
      typeof requestedWaitMs === "number" && requestedWaitMs >= 0
        ? Math.min(requestedWaitMs, DEFAULT_CONFIG.maxWaitMs)
        : this.getRecommendedWaitMs();

    if (waitMs <= 0) {
      return this.getSnapshot();
    }

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const onWake = () => {
        if (this.isSettled()) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          this.settleResolvers.delete(onWake);
          resolve();
        }
      };

      this.settleResolvers.add(onWake);

      timer = setTimeout(() => {
        this.settleResolvers.delete(onWake);
        resolve();
      }, waitMs);
    });

    return this.getSnapshot();
  }

  public getSnapshot(cursor = 0): TurnResultSnapshot {
    const slicedEvents = cursor > 0 ? this.events.slice(cursor) : [...this.events];
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      state: this.state,
      streamingText: this.streamingText,
      activeCommand: this.activeCommand ? { ...this.activeCommand } : null,
      pendingApproval: this.pendingApproval ? { ...this.pendingApproval } : null,
      events: slicedEvents,
      cursor: this.events.length,
      error: this.errorMessage,
      pollAttempt: this.pollAttempt,
      nextRecommendedWaitMs: this.getRecommendedWaitMs(),
    };
  }

  private wakeWaiters(): void {
    if (this.settleResolvers.size > 0) {
      const resolvers = Array.from(this.settleResolvers);
      this.settleResolvers.clear();
      for (const res of resolvers) {
        res();
      }
    }
  }
}
