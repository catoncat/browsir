export const SESSION_SCHEMA_VERSION = 1;

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

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  parentSessionId: string | null;
  timestamp: string;
  cwd?: string;
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

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  role: SessionMessageRole;
  text: string;
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

export interface SessionContextMessage {
  role: SessionMessageRole;
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
}

export interface SessionContext {
  sessionId: string;
  leafId: string | null;
  entries: SessionEntry[];
  previousSummary: string;
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

export interface RunState {
  sessionId: string;
  running: boolean;
  paused: boolean;
  stopped: boolean;
  retry: RetryState;
}

export interface StepTraceRecord {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
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
