import type { PanelMessageLike } from "./utils/message-actions";
import type { ToolPendingStepState } from "./utils/tool-formatters";

export type ViewMode =
  | "chat"
  | "settings"
  | "provider-settings"
  | "mcp-settings"
  | "skills"
  | "plugins"
  | "debug";

export interface SessionListRenderSessionItem {
  id: string;
  title?: string;
  updatedAt?: string;
  parentSessionId?: string;
  forkedFrom?: {
    sessionId?: string;
    leafId?: string;
    sourceEntryId?: string;
    reason?: string;
  } | null;
}

export interface DisplayMessage extends PanelMessageLike {
  role: string;
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
  toolPending?: boolean;
  toolPendingLeaving?: boolean;
  toolPendingStatus?: "running" | "done" | "failed";
  toolPendingHeadline?: string;
  toolPendingAction?: string;
  toolPendingDetail?: string;
  toolPendingSteps?: string[];
  toolPendingStepsData?: Array<{
    step: number;
    status: "running" | "done" | "failed";
    line: string;
    logs: string[];
  }>;
}

export interface QueuedPromptViewItem {
  id: string;
  behavior: "steer" | "followUp";
  text: string;
  timestamp: string;
}

export interface StepTraceRecord {
  type?: string;
  timestamp?: string;
  ts?: string;
  payload?: Record<string, unknown>;
}

export interface ToolRunSnapshot {
  step: number;
  action: string;
  arguments: string;
  ts: string;
}

export interface RuntimeProgressHint {
  phase: "llm" | "tool";
  label: string;
  detail: string;
  ts: string;
}

export type RunViewPhase = "idle" | "llm" | "tool_running" | "tool_handoff_leaving" | "final_assistant";

export interface RunViewState {
  phase: RunViewPhase;
  epoch: number;
  activeToolRun: ToolRunSnapshot | null;
  toolPendingStepStates: ToolPendingStepState[];
}

export interface RuntimeEventDigest {
  source: "brain" | "bridge";
  ts: string;
  type: string;
  preview: string;
  sessionId: string;
}

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
