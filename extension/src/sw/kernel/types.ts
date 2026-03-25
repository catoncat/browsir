import type { PromptContextRefInput } from "../../shared/context-ref";

export const SESSION_SCHEMA_VERSION = 1;
export type JsonRecord = Record<string, unknown>;

export type SessionEntryType =
  | "message"
  | "compaction"
  | "thinking_level_change"
  | "model_change"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";

export type SessionMessageRole = "system" | "user" | "assistant" | "tool";

export interface SessionWorkingContext {
  hostCwd?: string;
  browserCwd: "mem://";
  browserUserMount: "/mem";
}

export const DEFAULT_SESSION_WORKING_CONTEXT: Pick<
  SessionWorkingContext,
  "browserCwd" | "browserUserMount"
> = {
  browserCwd: "mem://",
  browserUserMount: "/mem",
};

function normalizeHostCwd(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

export function normalizeSessionWorkingContext(
  value: unknown,
): SessionWorkingContext {
  const row =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...DEFAULT_SESSION_WORKING_CONTEXT,
    ...(normalizeHostCwd(row.hostCwd)
      ? { hostCwd: normalizeHostCwd(row.hostCwd) }
      : {}),
  };
}

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  parentSessionId: string | null;
  timestamp: string;
  workingContext?: SessionWorkingContext;
  title?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionEntryBase {
  id: string;
  type: SessionEntryType;
  parentId: string | null;
  timestamp: string;
  custom?: Record<string, unknown>;
}

/** Ordered content block inside an assistant message (text + tool call mixed). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: string };

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  role: SessionMessageRole;
  text: string;
  /** Ordered content blocks for assistant messages with tool calls. Optional for backward compat. */
  contentBlocks?: ContentBlock[];
  toolName?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  reason: "overflow" | "threshold" | "manual";
  summary: string;
  firstKeptEntryId: string | null;
  previousSummary?: string;
  tokensBefore: number;
  tokensAfter: number;
  details?: Record<string, unknown>;
  fromHook?: boolean;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  value: string;
  previousValue?: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  model: string;
  previousModel?: string;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  summary: string;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  key: string;
  value: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  level: "info" | "warn" | "error";
  text: string;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  label: string;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  info: Record<string, unknown>;
}

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface SessionMeta {
  header: SessionHeader;
  leafId: string | null;
  entryCount: number;
  chunkCount: number;
  chunkSize: number;
  updatedAt: string;
}

export type SessionContextMessageRole = SessionMessageRole | "compactionSummary";

export interface SessionContextMessage {
  role: SessionContextMessageRole;
  content: string;
  llmContent?: string;
  contentBlocks?: ContentBlock[];
  entryId: string;
  toolName?: string;
  toolCallId?: string;
}

export interface SessionContext {
  sessionId: string;
  leafId: string | null;
  entries: SessionEntry[];
  messages: SessionContextMessage[];
}

export interface CompactionDraft {
  summary: string;
  firstKeptEntryId: string | null;
  previousSummary: string;
  keptEntries: SessionEntry[];
  droppedEntries: SessionEntry[];
  tokensBefore: number;
  tokensAfter: number;
}

export interface RetryState {
  active: boolean;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export type StreamingBehavior = "steer" | "followUp";
export type QueueDequeueMode = "one-at-a-time" | "all";

export interface QueuedRuntimePrompt {
  id: string;
  behavior: StreamingBehavior;
  text: string;
  skillIds?: string[];
  contextRefs?: PromptContextRefInput[];
  timestamp: string;
}

export interface RunQueueState {
  dequeueMode: QueueDequeueMode;
  steer: QueuedRuntimePrompt[];
  followUp: QueuedRuntimePrompt[];
}

export interface RunState {
  sessionId: string;
  running: boolean;
  compacting: boolean;
  paused: boolean;
  stopped: boolean;
  retry: RetryState;
  queue: RunQueueState;
}

export interface StepTraceRecord extends JsonRecord {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  payload: JsonRecord;
}

export type ExecuteMode = "script" | "cdp" | "bridge";
export type ExecuteCapability = string;

export interface ExecuteStepInput {
  sessionId: string;
  mode?: ExecuteMode;
  capability?: ExecuteCapability;
  action: string;
  args?: Record<string, unknown>;
  verifyPolicy?: "off" | "on_critical" | "always";
}

export interface ExecuteStepResult {
  ok: boolean;
  modeUsed: ExecuteMode;
  capabilityUsed?: ExecuteCapability;
  providerId?: string;
  fallbackFrom?: ExecuteMode;
  verified: boolean;
  verifyReason?: string;
  data?: unknown;
  error?: string;
  errorCode?: string;
  errorDetails?: unknown;
  retryable?: boolean;
}

export function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function approxTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
