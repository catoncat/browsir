/**
 * Shared types and constants for the runtime-loop module family.
 * Extracted from runtime-loop.browser.ts to break circular dependencies
 * between runtime-loop ↔ loop-tool-dispatch ↔ dispatch-plan-executor.
 */
import type {
  ExecuteCapability,
  ExecuteMode,
  ExecuteStepResult,
  RuntimeView,
} from "./orchestrator.browser";
import type { StreamingBehavior } from "./types";
import type { LlmResolvedRoute } from "./llm-provider";
import type { LlmProviderRegistry } from "./llm-provider-registry";

// ── Re-export JsonRecord from canonical source ──────────────────────
export type { JsonRecord } from "./types";
type JsonRecord = Record<string, unknown>;

// ── Runtime error type ──────────────────────────────────────────────

export type RuntimeErrorWithMeta = Error & {
  code?: string;
  details?: unknown;
  retryable?: boolean;
  status?: number;
};

// ── Loop controller public interface ────────────────────────────────

export interface RuntimeLoopController {
  startFromPrompt(
    input: RunStartInput,
  ): Promise<{ sessionId: string; runtime: RuntimeView }>;
  startFromRegenerate(
    input: RegenerateRunInput,
  ): Promise<{ sessionId: string; runtime: RuntimeView }>;
  executeStep(input: {
    sessionId: string;
    mode?: ExecuteMode;
    capability?: ExecuteCapability;
    action: string;
    args?: JsonRecord;
    verifyPolicy?: "off" | "on_critical" | "always";
  }): Promise<ExecuteStepResult>;
  refreshSessionTitle(
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<string>;
  getSystemPromptPreview(): Promise<string>;
}

// ── Tool call item ──────────────────────────────────────────────────

export interface ToolCallItem {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ── Failure / retry / progress types ────────────────────────────────

export type FailureReason =
  | "failed_execute"
  | "failed_verify"
  | "progress_uncertain";

export type LoopTerminalStatus =
  | "done"
  | FailureReason
  | "max_steps"
  | "stopped"
  | "timeout";

const FAILURE_REASON_SET = new Set<FailureReason>([
  "failed_execute",
  "failed_verify",
  "progress_uncertain",
]);

const LOOP_TERMINAL_STATUS_SET = new Set<LoopTerminalStatus>([
  "done",
  "failed_execute",
  "failed_verify",
  "progress_uncertain",
  "max_steps",
  "stopped",
  "timeout",
]);

export function normalizeFailureReasonValue(raw: unknown): FailureReason {
  const reason = String(raw || "")
    .trim()
    .toLowerCase();
  if (reason === "failed_verify") return "failed_verify";
  if (reason === "progress_uncertain") return "progress_uncertain";
  return "failed_execute";
}

export function isFailureReason(raw: unknown): raw is FailureReason {
  const reason = String(raw || "")
    .trim()
    .toLowerCase();
  return FAILURE_REASON_SET.has(reason as FailureReason);
}

export function normalizeLoopTerminalStatus(
  raw: unknown,
  fallback: LoopTerminalStatus = "done",
): LoopTerminalStatus {
  const status = String(raw || "")
    .trim()
    .toLowerCase();
  if (LOOP_TERMINAL_STATUS_SET.has(status as LoopTerminalStatus)) {
    return status as LoopTerminalStatus;
  }
  return fallback;
}

export function mapTerminalStatusToFailureReason(
  raw: unknown,
): FailureReason | null {
  const status = normalizeLoopTerminalStatus(raw, "done");
  return FAILURE_REASON_SET.has(status as FailureReason)
    ? (status as FailureReason)
    : null;
}

export function resolveAgentEndDoneReason(input: {
  status?: unknown;
  failureReason?: unknown;
  error?: unknown;
}): LoopTerminalStatus {
  const explicitFailureReason =
    input.failureReason == null || String(input.failureReason || "").trim() === ""
      ? null
      : normalizeFailureReasonValue(input.failureReason);
  if (explicitFailureReason) return explicitFailureReason;

  const statusFailureReason = mapTerminalStatusToFailureReason(input.status);
  if (statusFailureReason) return statusFailureReason;

  const status = normalizeLoopTerminalStatus(input.status, "done");
  if (status !== "done") return status;

  return input.error ? "failed_execute" : "done";
}

export type ToolRetryAction = "auto_replay" | "llm_replan" | "fail_fast";

export type NoProgressReason =
  | "repeat_signature"
  | "ping_pong"
  | "browser_proof_guard";

// ── Internal input interfaces ───────────────────────────────────────

export interface BashExecOutcome {
  cmdId: string;
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface RunStartInput {
  sessionId?: string;
  sessionOptions?: JsonRecord;
  prompt?: string;
  tabIds?: unknown[];
  skillIds?: unknown[];
  contextRefs?: unknown[];
  autoRun?: boolean;
  streamingBehavior?: StreamingBehavior;
}

export interface RegenerateRunInput {
  sessionId: string;
  prompt: string;
  autoRun?: boolean;
}

export interface LlmRequestInput {
  sessionId: string;
  route: LlmResolvedRoute;
  providerRegistry: LlmProviderRegistry;
  step: number;
  messages: JsonRecord[];
  toolChoice?: "auto" | "required";
  toolScope?: "all" | "browser_only";
}

// ── Exported constants ──────────────────────────────────────────────

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 300_000;

export const CAPABILITIES = {
  processExec: "process.exec",
  fsRead: "fs.read",
  fsWrite: "fs.write",
  fsEdit: "fs.edit",
  browserSnapshot: "browser.snapshot",
  browserAction: "browser.action",
  browserVerify: "browser.verify",
} as const;

export const CANONICAL_BROWSER_TOOL_NAMES = [
  "get_all_tabs",
  "get_current_tab",
  "create_new_tab",
  "get_tab_info",
  "close_tab",
  "ungroup_tabs",
  "search_elements",
  "click",
  "fill_element_by_uid",
  "select_option_by_uid",
  "hover_element_by_uid",
  "get_editor_value",
  "press_key",
  "scroll_page",
  "navigate_tab",
  "fill_form",
  "browser_verify",
  "computer",
  "get_page_metadata",
  "scroll_to_element",
  "highlight_element",
  "highlight_text_inline",
  "capture_screenshot",
  "capture_tab_screenshot",
  "capture_screenshot_with_highlight",
  "download_image",
  "download_chat_images",
  "list_interventions",
  "get_intervention_info",
  "request_intervention",
  "cancel_intervention",
  "create_skill",
  "load_skill",
  "execute_skill_script",
  "read_skill_reference",
  "get_skill_asset",
  "list_skills",
  "get_skill_info",
] as const;

export const RUNTIME_EXECUTABLE_TOOL_NAMES = new Set([
  "host_bash",
  "browser_bash",
  "host_read_file",
  "browser_read_file",
  "host_write_file",
  "browser_write_file",
  "host_edit_file",
  "browser_edit_file",
  ...CANONICAL_BROWSER_TOOL_NAMES,
]);

export const NO_PROGRESS_CONTINUE_BUDGET: Record<NoProgressReason, number> = {
  repeat_signature: 1,
  ping_pong: 0,
  browser_proof_guard: 4,
};

export const BROWSER_PROOF_REQUIRED_TOOL_NAMES = new Set([
  "click",
  "fill_element_by_uid",
  "select_option_by_uid",
  "hover_element_by_uid",
  "press_key",
  "scroll_page",
  "navigate_tab",
  "fill_form",
  "browser_verify",
  "computer",
  "scroll_to_element",
  "highlight_element",
  "highlight_text_inline",
  "capture_screenshot",
  "capture_tab_screenshot",
  "capture_screenshot_with_highlight",
  "download_image",
  "download_chat_images",
]);

// ── Internal constants (used only by runtime-loop) ──────────────────

export const MAX_LLM_RETRIES = 2;
export const MAX_DEBUG_CHARS = 24_000;
export const SESSION_TITLE_MAX = 28;
export const SESSION_TITLE_MIN = 2;
export const SESSION_TITLE_SOURCE_MANUAL = "manual";
export const SESSION_TITLE_SOURCE_AI = "ai";
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;
export const MIN_LLM_TIMEOUT_MS = 1_000;
export const MAX_LLM_TIMEOUT_MS = 300_000;
export const TOOL_AUTO_RETRY_BASE_DELAY_MS = 300;
export const TOOL_AUTO_RETRY_CAP_DELAY_MS = 2_000;
export const DEFAULT_LLM_MAX_RETRY_DELAY_MS = 60_000;
export const MIN_LLM_MAX_RETRY_DELAY_MS = 0;
export const MAX_LLM_MAX_RETRY_DELAY_MS = 300_000;
export const LLM_TRACE_BODY_PREVIEW_MAX_CHARS = 1_200;
export const LLM_TRACE_USER_SNIPPET_MAX_CHARS = 420;
export const MAX_PROMPT_SKILL_ITEMS = 64;
export const NO_PROGRESS_SIGNATURE_HISTORY_LIMIT = 6;
