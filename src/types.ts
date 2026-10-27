export type PermissionMode = "supervised" | "full-access" | "read-only";

export type ApprovalKind =
  | "command_approval"
  | "file_approval"
  | "permission_approval"
  | "user_input";

export type ApprovalDecision = "accept" | "decline" | "cancel";

export interface PendingApproval {
  interactionId: string;
  kind: ApprovalKind;
  threadId?: string;
  turnId?: string;
  rawMethod: string;
  details: Record<string, unknown>;
  createdAt: number;
}

export type TurnState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelling";

export interface ActiveCommandSnapshot {
  itemId: string;
  command: string;
  outputTail: string;
}

export interface TurnEventSnapshot {
  id: string;
  kind:
    | "item_started"
    | "item_completed"
    | "plan_updated"
    | "status"
    | "error"
    | "warning";
  message: string;
  timestamp: number;
}

export interface TurnResultSnapshot {
  threadId: string;
  turnId: string;
  state: TurnState;
  streamingText: string;
  activeCommand?: ActiveCommandSnapshot | null;
  pendingApproval?: PendingApproval | null;
  events: TurnEventSnapshot[];
  cursor: number;
  error?: string | null;
  pollAttempt: number;
  nextRecommendedWaitMs: number;
}

export interface SessionSummary {
  threadId: string;
  title?: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  model?: string;
  sourceKind?: string;
}

export interface SessionHistoryMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: number;
}

export interface SessionDetails {
  summary: SessionSummary;
  messages: SessionHistoryMessage[];
}
