import { JsonRpcRequest } from "../codex/jsonrpc.js";
import { ApprovalKind, PendingApproval } from "../types.js";

export class InteractionBroker {
  private pending = new Map<string, PendingApproval>();
  private resolvedIds = new Set<string>();

  public registerRequest(req: JsonRpcRequest): PendingApproval | null {
    const interactionId = String(req.id);
    if (this.resolvedIds.has(interactionId)) {
      return null;
    }

    const params = (req.params as Record<string, any>) || {};
    let kind: ApprovalKind | null = null;

    if (req.method === "item/commandExecution/requestApproval") {
      kind = "command_approval";
    } else if (req.method === "item/fileChange/requestApproval") {
      kind = "file_approval";
    } else if (req.method === "item/permissions/requestApproval") {
      kind = "permission_approval";
    } else if (req.method === "item/tool/requestUserInput") {
      kind = "user_input";
    }

    if (!kind) {
      return null;
    }

    const approval: PendingApproval = {
      interactionId,
      kind,
      threadId: params.threadId,
      turnId: params.turnId,
      rawMethod: req.method,
      details: params,
      createdAt: Date.now(),
    };

    this.pending.set(interactionId, approval);
    return approval;
  }

  public markResolved(interactionId: string): boolean {
    const idStr = String(interactionId);
    this.resolvedIds.add(idStr);
    return this.pending.delete(idStr);
  }

  public isResolved(interactionId: string): boolean {
    return this.resolvedIds.has(String(interactionId));
  }

  public getPending(interactionId: string): PendingApproval | undefined {
    return this.pending.get(String(interactionId));
  }

  public getCurrentPending(): PendingApproval | null {
    const first = this.pending.values().next();
    return first.done ? null : first.value;
  }

  public hasPending(): boolean {
    return this.pending.size > 0;
  }

  public takePending(interactionId: string): PendingApproval | null {
    const idStr = String(interactionId);
    const item = this.pending.get(idStr);
    if (item) {
      this.pending.delete(idStr);
      this.resolvedIds.add(idStr);
      return item;
    }
    return null;
  }

  public clear(): void {
    this.pending.clear();
    this.resolvedIds.clear();
  }
}
