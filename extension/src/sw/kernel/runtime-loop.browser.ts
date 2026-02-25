import {
  BrainOrchestrator,
  type ExecuteCapability,
  type ExecuteMode,
  type ExecuteStepResult,
  type RuntimeView
} from "./orchestrator.browser";
import { SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.browser";
import {
  buildCompactionSummaryLlmMessage,
  convertSessionContextMessagesToLlm,
  transformMessagesForLlm,
  type SessionContextMessageLike
} from "./llm-message-model.browser";
import { decideProfileEscalation, type LlmProfileEscalationPolicy } from "./llm-profile-policy";
import {
  DEFAULT_LLM_PROVIDER_ID,
  type LlmResolvedRoute
} from "./llm-provider";
import { LlmProviderRegistry } from "./llm-provider-registry";
import { createOpenAiCompatibleLlmProvider } from "./llm-openai-compatible-provider";
import { resolveLlmRoute } from "./llm-profile-resolver";
import { writeSessionMeta } from "./session-store.browser";
import { type BridgeConfig, type RuntimeInfraHandler } from "./runtime-infra.browser";
import { type CapabilityExecutionPolicy, type StepVerifyPolicy } from "./capability-policy";
import type { SkillMetadata } from "./skill-registry";
import {
  frameMatchesVirtualCapability,
  invokeVirtualFrame,
  isVirtualUri,
  shouldRouteFrameToBrowserVfs
} from "./virtual-fs.browser";
import { nowIso, type SessionEntry, type SessionMeta, type StreamingBehavior } from "./types";

type JsonRecord = Record<string, unknown>;

const MAX_LLM_RETRIES = 2;
const MAX_DEBUG_CHARS = 24_000;
const SESSION_TITLE_MAX = 28;
const SESSION_TITLE_MIN = 2;
const SESSION_TITLE_SOURCE_MANUAL = "manual";
const SESSION_TITLE_SOURCE_AI = "ai";
const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const MIN_LLM_TIMEOUT_MS = 1_000;
const MAX_LLM_TIMEOUT_MS = 300_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MIN_BASH_TIMEOUT_MS = 200;
const MAX_BASH_TIMEOUT_MS = 300_000;
const TOOL_AUTO_RETRY_MAX = 2;
const TOOL_AUTO_RETRY_BASE_DELAY_MS = 300;
const TOOL_AUTO_RETRY_CAP_DELAY_MS = 2_000;
const DEFAULT_LLM_MAX_RETRY_DELAY_MS = 60_000;
const MIN_LLM_MAX_RETRY_DELAY_MS = 0;
const MAX_LLM_MAX_RETRY_DELAY_MS = 300_000;
const LLM_TRACE_BODY_PREVIEW_MAX_CHARS = 1_200;
const LLM_TRACE_USER_SNIPPET_MAX_CHARS = 420;
const MAX_PROMPT_SKILL_ITEMS = 64;

type ToolRetryAction = "auto_replay" | "llm_replan" | "fail_fast";
type FailureReason = "failed_execute" | "failed_verify" | "progress_uncertain";
type FailurePhase = "plan" | "execute" | "verify" | "progress_guard";
type FailureCategory = "timeout" | "busy" | "missing_target" | "verify_failed" | "focus_required" | "no_progress" | "unknown";
type ResumeStrategy = "retry_same_args" | "retry_with_fresh_snapshot" | "replan";

interface ToolCallItem {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface RunStartInput {
  sessionId?: string;
  sessionOptions?: JsonRecord;
  prompt?: string;
  tabIds?: unknown[];
  autoRun?: boolean;
  streamingBehavior?: StreamingBehavior;
}

interface RegenerateRunInput {
  sessionId: string;
  prompt: string;
  autoRun?: boolean;
}

interface LlmRequestInput {
  sessionId: string;
  route: LlmResolvedRoute;
  providerRegistry: LlmProviderRegistry;
  step: number;
  messages: JsonRecord[];
  toolChoice?: "auto" | "required";
  toolScope?: "all" | "browser_only";
}

type RuntimeErrorWithMeta = Error & {
  code?: string;
  details?: unknown;
  retryable?: boolean;
  status?: number;
};

export interface RuntimeLoopController {
  startFromPrompt(input: RunStartInput): Promise<{ sessionId: string; runtime: RuntimeView }>;
  startFromRegenerate(input: RegenerateRunInput): Promise<{ sessionId: string; runtime: RuntimeView }>;
  executeStep(input: {
    sessionId: string;
    mode?: ExecuteMode;
    capability?: ExecuteCapability;
    action: string;
    args?: JsonRecord;
    verifyPolicy?: "off" | "on_critical" | "always";
  }): Promise<ExecuteStepResult>;
  refreshSessionTitle(sessionId: string, options?: { force?: boolean }): Promise<string>;
  getSystemPromptPreview(): Promise<string>;
}

const TOOL_CAPABILITIES = {
  bash: "process.exec",
  read_file: "fs.read",
  write_file: "fs.write",
  edit_file: "fs.edit",
  search_elements: "browser.snapshot",
  click: "browser.action",
  fill_element_by_uid: "browser.action",
  select_option_by_uid: "browser.action",
  press_key: "browser.action",
  scroll_page: "browser.action",
  navigate_tab: "browser.action",
  fill_form: "browser.action",
  browser_verify: "browser.verify"
} as const;

const CANONICAL_BROWSER_TOOL_NAMES = [
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
  "load_skill",
  "execute_skill_script",
  "read_skill_reference",
  "get_skill_asset",
  "list_skills",
  "get_skill_info"
] as const;

const BUILTIN_BRIDGE_CAPABILITY_PROVIDERS: Array<{ capability: ExecuteCapability; providerId: string }> = [
  {
    capability: TOOL_CAPABILITIES.bash,
    providerId: "runtime.builtin.capability.process.exec.bridge"
  },
  {
    capability: TOOL_CAPABILITIES.read_file,
    providerId: "runtime.builtin.capability.fs.read.bridge"
  },
  {
    capability: TOOL_CAPABILITIES.write_file,
    providerId: "runtime.builtin.capability.fs.write.bridge"
  },
  {
    capability: TOOL_CAPABILITIES.edit_file,
    providerId: "runtime.builtin.capability.fs.edit.bridge"
  }
];

const BUILTIN_VIRTUAL_FS_CAPABILITY_PROVIDERS: Array<{ capability: ExecuteCapability; providerId: string }> = [
  {
    capability: TOOL_CAPABILITIES.bash,
    providerId: "runtime.builtin.capability.process.exec.vfs"
  },
  {
    capability: TOOL_CAPABILITIES.read_file,
    providerId: "runtime.builtin.capability.fs.read.vfs"
  },
  {
    capability: TOOL_CAPABILITIES.write_file,
    providerId: "runtime.builtin.capability.fs.write.vfs"
  },
  {
    capability: TOOL_CAPABILITIES.edit_file,
    providerId: "runtime.builtin.capability.fs.edit.vfs"
  }
];

const BUILTIN_BROWSER_CAPABILITY_PROVIDERS: Array<{ capability: ExecuteCapability; providerId: string }> = [
  {
    capability: TOOL_CAPABILITIES.search_elements,
    providerId: "runtime.builtin.capability.browser.snapshot.cdp"
  },
  {
    capability: TOOL_CAPABILITIES.click,
    providerId: "runtime.builtin.capability.browser.action.cdp"
  },
  {
    capability: TOOL_CAPABILITIES.browser_verify,
    providerId: "runtime.builtin.capability.browser.verify.cdp"
  }
];

const RUNTIME_EXECUTABLE_TOOL_NAMES = new Set([
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  ...CANONICAL_BROWSER_TOOL_NAMES
]);

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

const FORBIDDEN_TOP_LEVEL_TOOL_SCHEMA_KEYS = ["oneOf", "anyOf", "allOf", "enum", "not"] as const;

function normalizeSchemaRequiredList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const value = String(item || "").trim();
    if (!value || dedup.has(value)) continue;
    dedup.add(value);
    out.push(value);
  }
  return out;
}

function sanitizeTopLevelToolSchemaForProvider(parameters: unknown, providerId: string): JsonRecord {
  const schema = toRecord(parameters);
  const provider = String(providerId || "").trim().toLowerCase();
  if (provider !== "openai_compatible") {
    return {
      ...schema
    };
  }

  const sanitized: JsonRecord = {
    ...schema,
    type: "object",
    properties: toRecord(schema.properties),
    required: normalizeSchemaRequiredList(schema.required)
  };

  for (const key of FORBIDDEN_TOP_LEVEL_TOOL_SCHEMA_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

function sanitizeLlmToolDefinitionForProvider(definition: unknown, providerId: string): JsonRecord {
  const def = toRecord(definition);
  const fn = toRecord(def.function);
  return {
    ...def,
    type: "function",
    function: {
      ...fn,
      name: String(fn.name || "").trim(),
      description: String(fn.description || ""),
      parameters: sanitizeTopLevelToolSchemaForProvider(fn.parameters, providerId)
    }
  };
}

function clipText(input: unknown, maxChars = MAX_DEBUG_CHARS): string {
  const text = String(input || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...<truncated:${text.length - maxChars}>`;
}

function safeStringify(input: unknown, maxChars = 9000): string {
  let text = "";
  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return clipText(text, maxChars);
}

function safeJsonParse(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
}

function normalizeRuntimeHint(raw: unknown): "browser" | "local" | undefined {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "browser") return "browser";
  if (value === "local") return "local";
  return undefined;
}

function estimateJsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).length;
  } catch {
    return 0;
  }
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const block = toRecord(item);
    if (typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (typeof block.input_text === "string") {
      parts.push(block.input_text);
      continue;
    }
    if (typeof block.content === "string") {
      parts.push(block.content);
    }
  }
  return parts.join("");
}

function summarizeLlmRequestPayload(payload: JsonRecord): JsonRecord {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let messageChars = 0;
  let maxMessageChars = 0;
  let toolMessageCount = 0;
  let lastUserSnippet = "";

  for (const item of messages) {
    const message = toRecord(item);
    const role = String(message.role || "").trim();
    if (role === "tool") toolMessageCount += 1;
    const text = extractContentText(message.content);
    const chars = text.length;
    messageChars += chars;
    if (chars > maxMessageChars) maxMessageChars = chars;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = toRecord(messages[i]);
    if (String(message.role || "") !== "user") continue;
    const text = extractContentText(message.content).trim();
    if (!text) continue;
    lastUserSnippet = clipText(text, LLM_TRACE_USER_SNIPPET_MAX_CHARS);
    break;
  }

  return {
    messageCount: messages.length,
    messageChars,
    maxMessageChars,
    toolMessageCount,
    toolDefinitionCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    requestBytes: estimateJsonBytes(payload),
    stream: payload.stream === true,
    temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
    lastUserSnippet
  };
}

function buildLlmRawTracePayload(input: {
  step: number;
  attempt: number;
  status: number;
  ok: boolean;
  body: string;
  retryDelayHintMs?: number | null;
}): JsonRecord {
  const body = String(input.body || "");
  return {
    step: input.step,
    attempt: input.attempt,
    status: input.status,
    ok: input.ok,
    retryDelayHintMs: input.retryDelayHintMs,
    bodyPreview: clipText(body, LLM_TRACE_BODY_PREVIEW_MAX_CHARS),
    bodyLength: body.length,
    bodyTruncated: body.length > LLM_TRACE_BODY_PREVIEW_MAX_CHARS
  };
}

function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function asRuntimeErrorWithMeta(error: unknown): RuntimeErrorWithMeta {
  if (error instanceof Error) return error as RuntimeErrorWithMeta;
  return new Error(String(error)) as RuntimeErrorWithMeta;
}

function isPlainJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createNonRetryableRuntimeError(code: string, message: string, details?: unknown): RuntimeErrorWithMeta {
  const err = new Error(message) as RuntimeErrorWithMeta;
  err.code = code;
  err.retryable = false;
  if (details !== undefined) {
    err.details = details;
  }
  return err;
}

function normalizeErrorCode(code: unknown): string {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function isSideEffectingToolName(toolName: string): boolean {
  const normalized = String(toolName || "").trim().toLowerCase();
  return [
    "write_file",
    "edit_file",
    "create_new_tab",
    "close_tab",
    "ungroup_tabs",
    "click",
    "fill_element_by_uid",
    "select_option_by_uid",
    "hover_element_by_uid",
    "press_key",
    "scroll_page",
    "navigate_tab",
    "scroll_to_element",
    "highlight_element",
    "highlight_text_inline",
    "fill_form",
    "computer",
    "download_image",
    "download_chat_images",
    "request_intervention",
    "cancel_intervention",
    "execute_skill_script"
  ].includes(normalized);
}

function classifyToolRetryDecision(toolName: string, errorCode: string): {
  action: ToolRetryAction;
  retryable: boolean;
  retryHint: string;
} {
  const normalizedCode = normalizeErrorCode(errorCode);
  const sideEffecting = isSideEffectingToolName(toolName);

  if (normalizedCode === "E_BUSY") {
    return {
      action: "auto_replay",
      retryable: true,
      retryHint: "Bridge is busy, retry after a short delay."
    };
  }

  if (normalizedCode === "E_BRIDGE_DISCONNECTED") {
    return {
      action: "auto_replay",
      retryable: true,
      retryHint: "Bridge connection was unstable; retry this tool call."
    };
  }

  if (normalizedCode === "E_TIMEOUT") {
    return {
      action: "llm_replan",
      retryable: true,
      retryHint:
        String(toolName || "").trim().toLowerCase() === "bash"
          ? "Increase bash.timeoutMs and retry the same goal."
          : "Operation timed out; adjust parameters and retry the same goal."
    };
  }

  if (normalizedCode === "E_CLIENT_TIMEOUT") {
    if (sideEffecting) {
      return {
        action: "llm_replan",
        retryable: true,
        retryHint: "Client timed out. Re-evaluate state with a fresh read/snapshot before retrying side effects."
      };
    }
    return {
      action: "auto_replay",
      retryable: true,
      retryHint: "Client timed out before receiving result; retry the same call."
    };
  }

  if (normalizedCode === "E_NO_TAB" || normalizedCode === "E_REF_REQUIRED" || normalizedCode === "E_VERIFY_FAILED") {
    return {
      action: "llm_replan",
      retryable: true,
      retryHint: "Refresh context (get_all_tabs/search_elements) and retry with updated target."
    };
  }

  return {
    action: "fail_fast",
    retryable: false,
    retryHint: "Retry only when the failure is transient."
  };
}

function isRetryableToolErrorCode(toolName: string, code: string): boolean {
  return classifyToolRetryDecision(toolName, code).retryable;
}

function shouldAutoReplayToolCall(toolName: string, code: string): boolean {
  return classifyToolRetryDecision(toolName, code).action === "auto_replay";
}

function computeToolRetryDelayMs(attempt: number): number {
  const next = TOOL_AUTO_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(TOOL_AUTO_RETRY_CAP_DELAY_MS, next);
}

function buildToolRetryHint(toolName: string, errorCode: string): string {
  return classifyToolRetryDecision(toolName, errorCode).retryHint;
}

function normalizeFailureReason(raw: unknown): FailureReason {
  const reason = String(raw || "").trim().toLowerCase();
  if (reason === "failed_verify") return "failed_verify";
  if (reason === "progress_uncertain") return "progress_uncertain";
  return "failed_execute";
}

function inferFailurePhase(reason: FailureReason): FailurePhase {
  if (reason === "failed_verify") return "verify";
  if (reason === "progress_uncertain") return "progress_guard";
  return "execute";
}

function isBrowserToolName(toolName: string): boolean {
  return CANONICAL_BROWSER_TOOL_NAMES.includes(
    String(toolName || "").trim().toLowerCase() as (typeof CANONICAL_BROWSER_TOOL_NAMES)[number]
  );
}

function inferModeEscalationDirective(input: {
  toolName: string;
  errorCode: string;
  errorText: string;
  retryHint: string;
  details: unknown;
  errorReason: FailureReason;
}): JsonRecord | null {
  if (!isBrowserToolName(input.toolName)) return null;

  const errorCode = normalizeErrorCode(input.errorCode);
  const combined = [
    String(input.errorText || ""),
    String(input.retryHint || ""),
    safeStringify(input.details || null, 600)
  ]
    .join(" ")
    .toLowerCase();
  const browserWriteFailureFallback =
    [
      "click",
      "fill_element_by_uid",
      "select_option_by_uid",
      "hover_element_by_uid",
      "press_key",
      "scroll_page",
      "navigate_tab",
      "scroll_to_element",
      "highlight_element",
      "highlight_text_inline",
      "fill_form",
      "computer",
      "browser_verify"
    ].includes(String(input.toolName || "").trim().toLowerCase()) &&
    (input.errorReason === "failed_execute" || input.errorReason === "failed_verify");
  const hasFocusSignal =
    errorCode === "E_VERIFY_FAILED" ||
    errorCode.startsWith("E_CDP_") ||
    /focus|foreground|background|active tab|user.?gesture|lease|后台/.test(combined) ||
    browserWriteFailureFallback;
  if (!hasFocusSignal) return null;

  return {
    suggested: true,
    from: "background",
    to: "focus",
    trigger: input.errorReason === "failed_verify" ? "verify_unstable" : "focus_required",
    prompt: "当前步骤疑似受后台执行限制。请切换到 focus 模式并续跑当前 step（无需重开会话）。",
    errorCode: errorCode || undefined
  };
}

function inferFailureCategory(input: {
  errorCode: string;
  errorReason: FailureReason;
  modeEscalation: JsonRecord | null;
}): FailureCategory {
  const errorCode = normalizeErrorCode(input.errorCode);
  if (input.errorReason === "progress_uncertain") return "no_progress";
  if (input.errorReason === "failed_verify" || errorCode === "E_VERIFY_FAILED") return "verify_failed";
  if (errorCode === "E_BUSY") return "busy";
  if (["E_TIMEOUT", "E_CLIENT_TIMEOUT", "E_CDP_TIMEOUT"].includes(errorCode)) return "timeout";
  if (["E_NO_TAB", "E_REF_REQUIRED", "E_CDP_RESOLVE_NODE", "E_CDP_AXTREE_EMPTY", "E_CDP_AXTREE_NO_NODES"].includes(errorCode)) {
    return "missing_target";
  }
  if (input.modeEscalation) return "focus_required";
  return "unknown";
}

function inferResumeStrategy(input: {
  errorReason: FailureReason;
  retryAction: ToolRetryAction;
  modeEscalation: JsonRecord | null;
  retryable: boolean;
}): ResumeStrategy {
  if (input.errorReason === "progress_uncertain") return "retry_with_fresh_snapshot";
  if (input.modeEscalation) return "retry_same_args";
  if (input.retryAction === "auto_replay") return "retry_same_args";
  if (input.retryAction === "llm_replan" && input.retryable) return "retry_with_fresh_snapshot";
  return "replan";
}

function mapNextBestAction(strategy: ResumeStrategy): string {
  if (strategy === "retry_same_args") return "retry_same_args";
  if (strategy === "retry_with_fresh_snapshot") return "refresh_snapshot_then_retry";
  return "replan_with_new_toolcall";
}

function attachFailureProtocol(
  toolName: string,
  payload: JsonRecord,
  options: {
    defaultRetryable?: boolean;
    errorReason?: FailureReason;
    phase?: FailurePhase;
    category?: FailureCategory;
    modeEscalation?: JsonRecord | null;
    resumeStrategy?: ResumeStrategy;
    stepRef?: JsonRecord | null;
  } = {}
): JsonRecord {
  const normalizedToolName = String(toolName || "").trim().toLowerCase();
  const errorCode = normalizeErrorCode(payload.errorCode);
  const errorReason = normalizeFailureReason(options.errorReason || payload.errorReason);
  const retryDecision = classifyToolRetryDecision(normalizedToolName, errorCode);
  const defaultRetryable = options.defaultRetryable === true;
  const retryable = payload.retryable === true || defaultRetryable || retryDecision.retryable;
  const retryHintBase = String(payload.retryHint || buildToolRetryHint(normalizedToolName, errorCode));
  const modeEscalation =
    options.modeEscalation !== undefined
      ? options.modeEscalation
      : inferModeEscalationDirective({
          toolName: normalizedToolName,
          errorCode,
          errorText: String(payload.error || ""),
          retryHint: retryHintBase,
          details: payload.details || payload.errorDetails || null,
          errorReason
        });
  let retryHint = retryHintBase;
  if (modeEscalation && !/focus|foreground|前台/.test(retryHint.toLowerCase())) {
    retryHint = `${retryHint} Switch to focus mode and resume the current step without restarting the session.`;
  }
  const failureCategory =
    options.category ||
    inferFailureCategory({
      errorCode,
      errorReason,
      modeEscalation
    });
  const retryAction = errorReason === "progress_uncertain" ? "llm_replan" : retryDecision.action;
  const resumeStrategy =
    options.resumeStrategy ||
    inferResumeStrategy({
      errorReason,
      retryAction,
      modeEscalation,
      retryable
    });
  const failureClass: JsonRecord = {
    phase: options.phase || inferFailurePhase(errorReason),
    reason: errorReason,
    category: failureCategory,
    retryAction
  };
  const resume: JsonRecord = {
    action: "resume_current_step",
    strategy: resumeStrategy
  };
  if (modeEscalation) resume.mode = "focus";

  const out: JsonRecord = {
    ...payload,
    errorCode: errorCode || undefined,
    errorReason,
    retryable,
    retryHint,
    next_best_action: mapNextBestAction(resumeStrategy),
    details: payload.details || payload.errorDetails || null,
    failureClass,
    resume
  };
  if (modeEscalation) out.modeEscalation = modeEscalation;
  if (options.stepRef && Object.keys(options.stepRef).length > 0) out.stepRef = options.stepRef;
  return out;
}

function normalizeTabIds(input: unknown[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of input) {
    const id = Number(raw);
    if (!Number.isInteger(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeStreamingBehavior(input: unknown): StreamingBehavior | null {
  const value = String(input || "").trim();
  if (value === "steer" || value === "followUp") return value;
  return null;
}

function extractTabIdsFromPrompt(prompt: string): number[] {
  const text = String(prompt || "");
  const ids: number[] = [];
  const seen = new Set<number>();
  const regex = /tabid\s*[:=]\s*(\d+)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const tabId = parsePositiveInt(match[1]);
    if (!tabId || seen.has(tabId)) continue;
    seen.add(tabId);
    ids.push(tabId);
  }
  return ids;
}

function normalizeSessionTitle(value: unknown, fallback = ""): string {
  const compact = String(value || "")
    .replace(/[`*_>#\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= SESSION_TITLE_MAX) return compact;
  return `${compact.slice(0, SESSION_TITLE_MAX)}…`;
}

function readSessionTitleSource(meta: SessionMeta | null): string {
  const metadata = toRecord(meta?.header?.metadata);
  const source = String(metadata.titleSource || "").trim().toLowerCase();
  if (source === SESSION_TITLE_SOURCE_MANUAL || source === SESSION_TITLE_SOURCE_AI) {
    return source;
  }
  return "";
}

function withSessionTitleMeta(meta: SessionMeta, title: string, source: string): SessionMeta {
  const metadata = {
    ...toRecord(meta.header.metadata)
  };
  if (source) {
    metadata.titleSource = source;
  } else {
    delete metadata.titleSource;
  }
  return {
    ...meta,
    header: {
      ...meta.header,
      title,
      metadata
    },
    updatedAt: nowIso()
  };
}

interface SessionLlmRoutePrefs {
  profile?: string;
  role?: string;
  escalationPolicy?: LlmProfileEscalationPolicy;
}

function readSessionLlmRoutePrefs(meta: SessionMeta | null): SessionLlmRoutePrefs {
  const metadata = toRecord(meta?.header?.metadata);
  const profile = String(metadata.llmProfile || "").trim();
  const role = String(metadata.llmRole || "").trim();
  const escalationPolicyRaw = String(metadata.llmEscalationPolicy || "").trim().toLowerCase();
  const escalationPolicy: LlmProfileEscalationPolicy | undefined =
    escalationPolicyRaw === "disabled" ? "disabled" : escalationPolicyRaw === "upgrade_only" ? "upgrade_only" : undefined;
  return {
    profile: profile || undefined,
    role: role || undefined,
    escalationPolicy
  };
}

function withSessionLlmRouteMeta(meta: SessionMeta, route: LlmResolvedRoute): SessionMeta {
  const metadata = {
    ...toRecord(meta.header.metadata),
    llmProfile: route.profile,
    llmProvider: route.provider,
    llmModel: route.llmModel,
    llmRole: route.role,
    llmEscalationPolicy: route.escalationPolicy
  };
  return {
    ...meta,
    header: {
      ...meta.header,
      metadata
    },
    updatedAt: nowIso()
  };
}

function buildLlmRoutePayload(route: LlmResolvedRoute, extra: JsonRecord = {}): JsonRecord {
  return {
    profile: route.profile,
    provider: route.provider,
    model: route.llmModel,
    role: route.role,
    fromLegacy: route.fromLegacy,
    ...extra
  };
}

function buildLlmFailureSignature(error: unknown): string {
  const err = asRuntimeErrorWithMeta(error);
  const code = normalizeErrorCode(err.code);
  const status = Number(err.status || 0);
  const msg = String(err.message || "")
    .trim()
    .toLowerCase()
    .slice(0, 180);
  return `${code || "E_UNKNOWN"}|${status || 0}|${msg}`;
}

function parseLlmContent(message: unknown): string {
  const payload = toRecord(message);
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) {
    const parts = payload.content
      .map((part) => {
        if (typeof part === "string") return part;
        const item = toRecord(part);
        if (typeof item.text === "string") return item.text;
        if (item.type === "text" && typeof item.value === "string") return item.value;
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  const content = toRecord(payload.content);
  if (typeof content.text === "string") return content.text;
  return "";
}

function normalizeVerifyExpect(raw: unknown): JsonRecord | null {
  const source = toRecord(raw);
  const out: JsonRecord = {};
  if (typeof source.urlContains === "string" && source.urlContains.trim()) out.urlContains = source.urlContains.trim();
  if (typeof source.titleContains === "string" && source.titleContains.trim()) out.titleContains = source.titleContains.trim();
  if (typeof source.textIncludes === "string" && source.textIncludes.trim()) out.textIncludes = source.textIncludes.trim();
  if (typeof source.selectorExists === "string" && source.selectorExists.trim()) out.selectorExists = source.selectorExists.trim();
  if (source.urlChanged === true) out.urlChanged = true;
  if (typeof source.previousUrl === "string" && source.previousUrl.trim()) out.previousUrl = source.previousUrl.trim();
  return Object.keys(out).length > 0 ? out : null;
}

function buildObserveProgressVerify(beforeObserve: unknown, afterObserve: unknown): JsonRecord {
  const beforePage = toRecord(toRecord(beforeObserve).page);
  const afterPage = toRecord(toRecord(afterObserve).page);
  const checks = [
    {
      name: "urlChanged",
      pass: String(beforePage.url || "") !== String(afterPage.url || ""),
      before: beforePage.url || "",
      after: afterPage.url || ""
    },
    {
      name: "titleChanged",
      pass: String(beforePage.title || "") !== String(afterPage.title || ""),
      before: beforePage.title || "",
      after: afterPage.title || ""
    },
    {
      name: "textLengthChanged",
      pass: Number(beforePage.textLength || 0) !== Number(afterPage.textLength || 0),
      before: Number(beforePage.textLength || 0),
      after: Number(afterPage.textLength || 0)
    },
    {
      name: "nodeCountChanged",
      pass: Number(beforePage.nodeCount || 0) !== Number(afterPage.nodeCount || 0),
      before: Number(beforePage.nodeCount || 0),
      after: Number(afterPage.nodeCount || 0)
    }
  ];

  return {
    ok: checks.some((item) => item.pass),
    checks,
    observation: afterObserve
  };
}

function normalizeToolCalls(rawToolCalls: unknown): ToolCallItem[] {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls
    .map((item, index) => {
      const row = toRecord(item);
      const fn = toRecord(row.function);
      const name = String(fn.name || "").trim();
      if (!name) return null;
      const argsText = typeof fn.arguments === "string" ? fn.arguments : safeStringify(fn.arguments || {});
      return {
        id: String(row.id || `toolcall-${index + 1}`),
        type: "function" as const,
        function: {
          name,
          arguments: argsText
        }
      };
    })
    .filter((item): item is ToolCallItem => item !== null);
}

function sortJsonForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonForSignature(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    out[key] = sortJsonForSignature(source[key]);
  }
  return out;
}

function normalizeToolArgsForSignature(rawArgs: unknown): string {
  const text = String(rawArgs || "").trim();
  if (!text) return "{}";
  const parsed = safeJsonParse(text);
  if (parsed !== null) {
    return clipText(safeStringify(sortJsonForSignature(parsed), 1200), 1200);
  }
  return clipText(text.replace(/\s+/g, " "), 1200);
}

function parseToolCallArgs(raw: string): JsonRecord | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as JsonRecord;
}

function stringifyToolCallArgs(args: JsonRecord): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

function buildFocusEscalationToolCall(toolCall: ToolCallItem): ToolCallItem | null {
  const normalized = String(toolCall.function.name || "").trim().toLowerCase();
  if (
    ![
      "click",
      "fill_element_by_uid",
      "select_option_by_uid",
      "hover_element_by_uid",
      "press_key",
      "scroll_page",
      "navigate_tab",
      "scroll_to_element",
      "highlight_element",
      "highlight_text_inline",
      "fill_form"
    ].includes(normalized)
  ) {
    return null;
  }
  const args = parseToolCallArgs(toolCall.function.arguments || "");
  if (!args) return null;
  const nextArgs: JsonRecord = {
    ...args,
    forceFocus: true
  };
  const nestedAction = toRecord(nextArgs.action);
  if (Object.keys(nestedAction).length > 0) {
    nextArgs.action = {
      ...nestedAction,
      forceFocus: true
    };
  }
  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: stringifyToolCallArgs(nextArgs)
    }
  };
}

function summarizeToolTarget(toolName: string, args: JsonRecord | null, rawArgs: string): string {
  const normalized = String(toolName || "").trim().toLowerCase();
  const raw = String(rawArgs || "").trim();
  const pick = (key: string) => String(args?.[key] || "").trim();

  if (normalized === "bash") {
    const command = pick("command") || raw;
    return command ? `命令：${clipText(command, 220)}` : "";
  }
  if (normalized === "create_new_tab") {
    const url = pick("url");
    return url ? `目标：${clipText(url, 220)}` : "";
  }
  if (normalized === "get_tab_info") {
    const tabId = pick("tabId");
    return tabId ? `读取标签页详情 · tabId=${clipText(tabId, 80)}` : "读取标签页详情";
  }
  if (normalized === "close_tab") {
    const tabId = pick("tabId");
    return tabId ? `关闭标签页 · tabId=${clipText(tabId, 80)}` : "关闭当前标签页";
  }
  if (normalized === "ungroup_tabs") {
    return "取消标签页分组";
  }
  if (["read_file", "write_file", "edit_file"].includes(normalized)) {
    const path = pick("path");
    return path ? `路径：${clipText(path, 220)}` : "";
  }
  if (normalized === "search_elements") {
    const query = pick("query");
    const selector = pick("selector");
    if (query && selector) return `元素检索：${clipText(query, 120)} · 作用域：${clipText(selector, 120)}`;
    if (query) return `元素检索：${clipText(query, 120)}`;
    if (selector) return `元素检索作用域：${clipText(selector, 120)}`;
    return "元素检索";
  }
  if (normalized === "click") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `点击 · ${clipText(target, 180)}` : "点击";
  }
  if (normalized === "fill_element_by_uid") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `填写 · ${clipText(target, 180)}` : "填写";
  }
  if (normalized === "select_option_by_uid") {
    const target = pick("uid") || pick("ref") || pick("selector");
    const value = pick("value");
    if (target && value) return `选择选项 · ${clipText(target, 120)} = ${clipText(value, 120)}`;
    return target ? `选择选项 · ${clipText(target, 180)}` : "选择选项";
  }
  if (normalized === "hover_element_by_uid") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `悬停 · ${clipText(target, 180)}` : "悬停元素";
  }
  if (normalized === "get_editor_value") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `读取编辑器内容 · ${clipText(target, 180)}` : "读取编辑器内容";
  }
  if (normalized === "press_key") {
    const key = pick("key") || pick("value");
    return key ? `按键 · ${clipText(key, 120)}` : "按键";
  }
  if (normalized === "scroll_page") {
    const delta = pick("deltaY") || pick("value");
    return delta ? `滚动页面 · ${clipText(delta, 120)}` : "滚动页面";
  }
  if (normalized === "navigate_tab") {
    const url = pick("url");
    return url ? `导航 · ${clipText(url, 220)}` : "导航";
  }
  if (normalized === "fill_form") {
    const elements = Array.isArray(args?.elements) ? args?.elements : [];
    return `批量填表：${elements.length} 项`;
  }
  if (normalized === "computer") {
    const action = pick("action");
    return action ? `视觉操作 · ${clipText(action, 120)}` : "视觉操作";
  }
  if (normalized === "get_page_metadata") return "读取页面元信息";
  if (normalized === "scroll_to_element") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `滚动到元素 · ${clipText(target, 180)}` : "滚动到元素";
  }
  if (normalized === "highlight_element") {
    const target = pick("uid") || pick("ref") || pick("selector");
    return target ? `高亮元素 · ${clipText(target, 180)}` : "高亮元素";
  }
  if (normalized === "highlight_text_inline") {
    const selector = pick("selector");
    const text = pick("searchText");
    if (selector && text) return `高亮文本 · ${clipText(text, 120)} @ ${clipText(selector, 120)}`;
    return "高亮文本";
  }
  if (normalized === "capture_screenshot") return "截图";
  if (normalized === "capture_tab_screenshot") {
    const tabId = pick("tabId");
    return tabId ? `标签页截图 · tabId=${clipText(tabId, 80)}` : "标签页截图";
  }
  if (normalized === "capture_screenshot_with_highlight") {
    const selector = pick("selector");
    return selector ? `高亮截图 · ${clipText(selector, 120)}` : "高亮截图";
  }
  if (normalized === "download_image") {
    const filename = pick("filename");
    return filename ? `下载图片 · ${clipText(filename, 160)}` : "下载图片";
  }
  if (normalized === "download_chat_images") return "批量下载聊天图片";
  if (normalized === "list_interventions") return "读取可用人工干预";
  if (normalized === "get_intervention_info") {
    const type = pick("type");
    return type ? `读取干预详情 · ${clipText(type, 120)}` : "读取干预详情";
  }
  if (normalized === "request_intervention") {
    const type = pick("type");
    return type ? `请求人工干预 · ${clipText(type, 120)}` : "请求人工干预";
  }
  if (normalized === "cancel_intervention") {
    const id = pick("id");
    return id ? `取消干预 · ${clipText(id, 160)}` : "取消干预";
  }
  if (normalized === "load_skill") {
    const name = pick("name");
    return name ? `加载技能 · ${clipText(name, 160)}` : "加载技能";
  }
  if (normalized === "execute_skill_script") {
    const name = pick("skillName");
    const scriptPath = pick("scriptPath");
    if (name && scriptPath) return `执行技能脚本 · ${clipText(name, 120)}:${clipText(scriptPath, 120)}`;
    return "执行技能脚本";
  }
  if (normalized === "read_skill_reference") {
    const name = pick("skillName");
    const refPath = pick("refPath");
    if (name && refPath) return `读取技能参考 · ${clipText(name, 120)}:${clipText(refPath, 120)}`;
    return "读取技能参考";
  }
  if (normalized === "get_skill_asset") {
    const name = pick("skillName");
    const assetPath = pick("assetPath");
    if (name && assetPath) return `读取技能资产 · ${clipText(name, 120)}:${clipText(assetPath, 120)}`;
    return "读取技能资产";
  }
  if (normalized === "list_skills") return "读取技能列表";
  if (normalized === "get_skill_info") {
    const name = pick("skillName");
    return name ? `读取技能详情 · ${clipText(name, 160)}` : "读取技能详情";
  }
  if (normalized === "browser_verify") return "页面验证";
  if (normalized === "get_all_tabs") return "读取标签页列表";
  if (normalized === "get_current_tab") return "读取当前标签页";
  if (raw) return `参数：${clipText(raw, 220)}`;
  return "";
}

function scoreSearchNode(node: JsonRecord, needles: string[]): { score: number; matchedNeedles: number } {
  if (needles.length === 0) return { score: 0, matchedNeedles: 0 };
  const role = String(node.role || "").toLowerCase();
  const tag = String(node.tag || "").toLowerCase();
  const name = String(node.name || "").toLowerCase();
  const value = String(node.value || "").toLowerCase();
  const placeholder = String(node.placeholder || "").toLowerCase();
  const ariaLabel = String(node.ariaLabel || "").toLowerCase();
  const selector = String(node.selector || "").toLowerCase();
  const haystack = [role, tag, name, value, placeholder, ariaLabel, selector].join(" ");

  let score = 0;
  let matchedNeedles = 0;
  for (const needle of needles) {
    if (!needle) continue;
    let hit = false;

    const exactInPrimary = [placeholder, ariaLabel, name].some((item) => item === needle);
    if (exactInPrimary) {
      score += 42;
      hit = true;
    }

    const startsInPrimary = [placeholder, ariaLabel, name].some((item) => item.startsWith(needle));
    if (startsInPrimary) {
      score += 24;
      hit = true;
    }

    const containsInPrimary = [placeholder, ariaLabel, name].some((item) => item.includes(needle));
    if (containsInPrimary) {
      score += 16;
      hit = true;
    }

    if (selector.includes(needle)) {
      score += 12;
      hit = true;
    }

    if (role === needle || tag === needle) {
      score += 16;
      hit = true;
    } else if (role.includes(needle) || tag.includes(needle)) {
      score += 8;
      hit = true;
    }

    if (value.includes(needle)) {
      score += 6;
      hit = true;
    }

    if (!hit && haystack.includes(needle)) {
      score += 3;
      hit = true;
    }

    if (hit) matchedNeedles += 1;
  }

  if (["input", "textarea", "button", "a", "select"].includes(tag)) score += 6;
  if (["textbox", "searchbox", "button", "link", "combobox"].includes(role)) score += 6;
  if (node.focused === true) score += 2;
  if (node.disabled === true) score -= 20;
  if (selector.includes("[data-testid=") || selector.includes("[aria-label=") || selector.includes("[placeholder=")) {
    score += 2;
  }
  const editable = node.editable === true;
  const typingIntent = needles.some((needle) =>
    ["input", "textarea", "textbox", "text", "type", "fill", "write", "compose", "edit", "输入", "文本", "回复", "comment"].some(
      (token) => needle.includes(token) || token.includes(needle)
    )
  );
  if (typingIntent) {
    const looksTypable =
      editable ||
      ["input", "textarea"].includes(tag) ||
      ["textbox", "searchbox", "combobox"].includes(role) ||
      selector.includes("contenteditable");
    if (looksTypable) score += 28;
    if ((role === "div" || !role) && tag === "div") score -= 18;
    if (selector.includes("_label") || selector.includes("label")) score -= 18;
    if (role === "button") score -= 12;
  }
  return { score, matchedNeedles };
}

function buildToolFailurePayload(toolCall: ToolCallItem, result: JsonRecord): JsonRecord {
  const toolName = String(toolCall.function.name || "").trim();
  const rawArgs = String(toolCall.function.arguments || "").trim();
  const args = parseToolCallArgs(rawArgs);
  const target = summarizeToolTarget(toolName, args, rawArgs);
  const errorCode = normalizeErrorCode(result.errorCode);
  const retryable = result.retryable === true || isRetryableToolErrorCode(toolName, errorCode);
  return {
    error: String(result.error || "工具执行失败"),
    errorReason: String(result.errorReason || "failed_execute"),
    errorCode: errorCode || undefined,
    retryable,
    retryHint: String(result.retryHint || buildToolRetryHint(toolName, errorCode)),
    tool: toolName,
    target,
    args: args || null,
    rawArgs: args ? undefined : clipText(rawArgs, 1200),
    details: result.details || null,
    failureClass: result.failureClass || undefined,
    modeEscalation: result.modeEscalation || undefined,
    resume: result.resume || undefined,
    stepRef: result.stepRef || undefined
  };
}

function buildToolSuccessPayload(toolCall: ToolCallItem, data: unknown): JsonRecord {
  const toolName = String(toolCall.function.name || "").trim();
  const rawArgs = String(toolCall.function.arguments || "").trim();
  const args = parseToolCallArgs(rawArgs);
  const target = summarizeToolTarget(toolName, args, rawArgs);
  const base = data && typeof data === "object" && !Array.isArray(data) ? ({ ...(data as JsonRecord) } as JsonRecord) : { data };
  return {
    ...base,
    tool: toolName,
    target,
    args: args || null
  };
}

function parseLlmMessageFromSse(rawBody: string): JsonRecord {
  const lines = String(rawBody || "").split(/\r?\n/);
  const toolByIndex = new Map<number, ToolCallItem>();
  let text = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = safeJsonParse(data);
    const packet = toRecord(parsed);
    const choices = Array.isArray(packet.choices) ? packet.choices : [];
    for (const choice of choices) {
      const row = toRecord(choice);
      const delta = toRecord(row.delta || row.message);
      if (typeof delta.content === "string") {
        text += delta.content;
      }
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawCall of toolCalls) {
        const call = toRecord(rawCall);
        const idx = Number.isInteger(call.index) ? Number(call.index) : 0;
        const prev = toolByIndex.get(idx) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" }
        };
        if (typeof call.id === "string" && call.id) prev.id = call.id;
        const fn = toRecord(call.function);
        if (typeof fn.name === "string" && fn.name) {
          prev.function.name = prev.function.name ? `${prev.function.name}${fn.name}` : fn.name;
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          prev.function.arguments = `${prev.function.arguments || ""}${fn.arguments}`;
        }
        toolByIndex.set(idx, prev);
      }
    }
  }

  return {
    content: text,
    tool_calls: Array.from(toolByIndex.keys())
      .sort((a, b) => a - b)
      .map((idx) => toolByIndex.get(idx))
      .filter((item): item is ToolCallItem => Boolean(item))
  };
}

interface LlmSseStreamResult {
  message: JsonRecord;
  rawBody: string;
  packetCount: number;
}

function extractDeltaText(delta: JsonRecord): string {
  const content = delta.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let out = "";
  for (const item of content) {
    const row = toRecord(item);
    const text = row.text;
    if (typeof text === "string") {
      out += text;
      continue;
    }
    const nested = row.content;
    if (typeof nested === "string") out += nested;
  }
  return out;
}

function appendDeltaToolCalls(toolByIndex: Map<number, ToolCallItem>, delta: JsonRecord): void {
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const rawCall of toolCalls) {
    const call = toRecord(rawCall);
    const idx = Number.isInteger(call.index) ? Number(call.index) : 0;
    const prev = toolByIndex.get(idx) || {
      id: "",
      type: "function" as const,
      function: { name: "", arguments: "" }
    };
    if (typeof call.id === "string" && call.id) prev.id = call.id;
    const fn = toRecord(call.function);
    if (typeof fn.name === "string" && fn.name) {
      prev.function.name = prev.function.name ? `${prev.function.name}${fn.name}` : fn.name;
    }
    if (typeof fn.arguments === "string" && fn.arguments) {
      prev.function.arguments = `${prev.function.arguments || ""}${fn.arguments}`;
    }
    toolByIndex.set(idx, prev);
  }
}

async function readLlmMessageFromSseStream(
  body: ReadableStream<Uint8Array>,
  onDeltaText?: (chunk: string) => void
): Promise<LlmSseStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let packetCount = 0;
  const rawPackets: string[] = [];
  const toolByIndex = new Map<number, ToolCallItem>();

  const processLine = (rawLine: string) => {
    const line = String(rawLine || "").trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    rawPackets.push(`data: ${data}`);
    if (data === "[DONE]") return;

    const parsed = safeJsonParse(data);
    const packet = toRecord(parsed);
    packetCount += 1;
    const choices = Array.isArray(packet.choices) ? packet.choices : [];
    for (const choice of choices) {
      const row = toRecord(choice);
      const delta = toRecord(row.delta || row.message);
      const textChunk = extractDeltaText(delta);
      if (textChunk) {
        text += textChunk;
        if (onDeltaText) onDeltaText(textChunk);
      }
      appendDeltaToolCalls(toolByIndex, delta);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineBreak = buffer.indexOf("\n");
    while (lineBreak >= 0) {
      const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
      buffer = buffer.slice(lineBreak + 1);
      processLine(line);
      lineBreak = buffer.indexOf("\n");
    }
  }

  const tail = buffer + decoder.decode();
  if (tail.trim()) processLine(tail.replace(/\r$/, ""));

  const message: JsonRecord = {
    content: text,
    tool_calls: Array.from(toolByIndex.keys())
      .sort((a, b) => a - b)
      .map((idx) => toolByIndex.get(idx))
      .filter((item): item is ToolCallItem => Boolean(item))
  };

  return {
    message,
    rawBody: rawPackets.join("\n"),
    packetCount
  };
}

function parseLlmMessageFromBody(rawBody: string, contentType: string): JsonRecord {
  const body = String(rawBody || "");
  const lowerType = String(contentType || "").toLowerCase();
  if (lowerType.includes("text/event-stream") || body.trim().startsWith("data:")) {
    return parseLlmMessageFromSse(body);
  }
  const parsed = safeJsonParse(body);
  const payload = toRecord(parsed);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return toRecord(toRecord(choices[0]).message);
}

function buildSharedTabsContextMessage(sharedTabs: unknown): string {
  if (!Array.isArray(sharedTabs) || sharedTabs.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < sharedTabs.length; i += 1) {
    const item = toRecord(sharedTabs[i]);
    const title = String(item.title || "").trim() || "(untitled)";
    const url = String(item.url || "").trim() || "";
    const id = Number(item.id);
    const tabIdPart = Number.isInteger(id) ? ` [id=${id}]` : "";
    lines.push(`${i + 1}. ${title}${tabIdPart}${url ? `\n   URL: ${url}` : ""}`);
  }
  return [
    "Shared tabs context (user-selected):",
    ...lines,
    "Use this context directly before deciding whether to call get_all_tabs/create_new_tab.",
    "For browser tasks, do not claim done until browser actions are verified."
  ].join("\n");
}

function escapeXmlAttributeForPrompt(input: unknown): string {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildAvailableSkillsSystemMessage(skills: SkillMetadata[]): string {
  const visible = (Array.isArray(skills) ? skills : []).filter(
    (item) => item && item.enabled && item.disableModelInvocation !== true
  );
  if (!visible.length) return "";

  const sorted = [...visible].sort((a, b) => {
    const byName = String(a.name || "").localeCompare(String(b.name || ""));
    if (byName !== 0) return byName;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  const limited = sorted.slice(0, MAX_PROMPT_SKILL_ITEMS);
  const lines = limited.map((skill) => {
    return `  <skill name="${escapeXmlAttributeForPrompt(skill.name)}" description="${escapeXmlAttributeForPrompt(
      skill.description
    )}" location="${escapeXmlAttributeForPrompt(skill.location)}" source="${escapeXmlAttributeForPrompt(skill.source)}" />`;
  });
  if (sorted.length > limited.length) {
    lines.push(`  <!-- truncated ${sorted.length - limited.length} more skills -->`);
  }

  return [
    "Available skills are instruction resources (not executable sandboxes).",
    "When a skill is relevant, use read_file with its location to load SKILL.md.",
    "<available_skills>",
    ...lines,
    "</available_skills>"
  ].join("\n");
}

const EXTENSION_AGENT_PROMPT_TOOL_ORDER = [
  "read_file",
  "write_file",
  "edit_file",
  "bash",
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
  "load_skill",
  "execute_skill_script",
  "read_skill_reference",
  "get_skill_asset",
  "list_skills",
  "get_skill_info",
  "browser_verify"
] as const;

const EXTENSION_AGENT_PROMPT_TOOL_DESCRIPTIONS: Record<string, string> = {
  read_file: "Read file contents from local FS or browser virtual FS (mem://, vfs://).",
  write_file: "Create or overwrite files on local FS or browser virtual FS.",
  edit_file: "Patch files with exact oldText/newText replacement.",
  bash: "Execute shell commands through bridge bash.exec (supports runtime + timeoutMs).",
  get_all_tabs: "List currently open browser tabs.",
  get_current_tab: "Get the active browser tab context.",
  create_new_tab: "Open a new browser tab when task flow requires it.",
  get_tab_info: "Get detailed tab metadata by tabId.",
  close_tab: "Close a specific tab or current tab.",
  ungroup_tabs: "Ungroup tab groups in current window.",
  search_elements:
    "Capture accessibility-first page snapshot to discover actionable targets. Query should describe user-visible semantics (placeholder/aria/name/text).",
  click: "Click a specific page element by uid/ref/backendNodeId.",
  fill_element_by_uid: "Type/fill a specific page element by uid/ref/backendNodeId.",
  select_option_by_uid: "Select/set value on a selectable page element by uid/ref/backendNodeId.",
  hover_element_by_uid: "Hover a target element by uid/ref/backendNodeId.",
  get_editor_value: "Read full value from input/textarea/contenteditable/editor target.",
  press_key: "Press a keyboard key on active element (e.g. Enter/Escape/ArrowDown).",
  scroll_page: "Scroll page by deltaY pixels (positive=down, negative=up).",
  navigate_tab: "Navigate tab to target URL.",
  fill_form: "Fill multiple form fields in one structured call.",
  computer: "Coordinate-based browser interaction (click/hover/scroll/key/type/wait/drag).",
  get_page_metadata: "Read page metadata (title/url/description/keywords/author/og).",
  scroll_to_element: "Scroll target element into view by selector or uid/ref/backendNodeId.",
  highlight_element: "Highlight element for visual confirmation.",
  highlight_text_inline: "Highlight matched text under selector scope.",
  capture_screenshot: "Capture screenshot and return base64 data URL.",
  capture_tab_screenshot: "Capture screenshot for a specific tab id.",
  capture_screenshot_with_highlight: "Capture screenshot with optional highlight selector.",
  download_image: "Download data:image URL to local browser downloads.",
  download_chat_images: "Batch-download image parts from message payload.",
  list_interventions: "List available human intervention types.",
  get_intervention_info: "Read intervention schema/details by type.",
  request_intervention: "Request a human intervention task.",
  cancel_intervention: "Cancel a pending intervention request.",
  load_skill: "Load skill main content (SKILL.md).",
  execute_skill_script: "Execute script under a skill package.",
  read_skill_reference: "Read skill reference doc under references/.",
  get_skill_asset: "Read skill asset under assets/.",
  list_skills: "List installed skills.",
  get_skill_info: "Get detailed skill metadata.",
  browser_verify: "Assert URL/title/text/selector to confirm the task actually progressed."
};

const EXTENSION_AGENT_PROMPT_BASE_GUIDELINES = [
  "Use tools instead of guessing. Ground decisions in tool outputs.",
  "For file tasks, read_file before edit_file/write_file.",
  "Prefer edit_file for surgical changes; use write_file for new files or full rewrites.",
  "For browser tasks, enforce: semantic search -> action -> browser_verify.",
  "Use user-visible query words in search_elements (placeholder/label/text), avoid implementation-only query text.",
  "For click/fill/select/hover/get_editor_value/scroll_to/highlight, prefer uid/ref/backendNodeId from latest search_elements; selector is fallback only.",
  "When goal is typing text, prioritize editable targets only (input/textarea/contenteditable/role=textbox). Avoid label/toolBar/container nodes even if text matches.",
  "For state-changing actions (click/fill/select/press/navigate/fill_form/computer/download/intervention), include expect whenever success criteria is clear.",
  "Never claim done when verify failed, verify skipped, or verify has empty checks.",
  "If fill/type says target is not typable, stop repeating same uid/selector; re-search with typing intent (textbox/input/contenteditable) and switch target.",
  "Avoid blind repeat: do not run identical search_elements query+selector multiple times without strategy change.",
  "Avoid blind click: never click toggle-like controls before reading current state label/count.",
  "For toggle-like controls (like/follow/bookmark), read current label/state first to avoid accidental flip.",
  "If browser_verify fails, do not claim done; re-observe and retry with updated target or expectation.",
  "Do not invent selectors, URLs, tab state, or command output; re-observe when uncertain.",
  "Use mem:// or vfs:// paths (or runtime=browser) for browser virtual files; use regular paths (or runtime=local) for local files.",
  "When tab context is ambiguous, query get_current_tab/get_all_tabs before acting.",
  "Be concise. Show key file paths, tab context, and blockers clearly."
];

function buildBrowserAgentSystemPrompt(config: BridgeConfig): string {
  const overridePrompt = String(config.llmSystemPromptCustom || "");
  if (overridePrompt.trim()) {
    return overridePrompt;
  }

  const tools = EXTENSION_AGENT_PROMPT_TOOL_ORDER
    .map((name) => `- ${name}: ${EXTENSION_AGENT_PROMPT_TOOL_DESCRIPTIONS[name] || "Use when needed."}`)
    .join("\n");
  const guidelines = EXTENSION_AGENT_PROMPT_BASE_GUIDELINES.map((line) => `- ${line}`).join("\n");
  return [
    "You are an expert coding assistant operating inside Browser Brain Loop, a browser-extension agent harness.",
    "You help users by reading files, executing commands, editing code, writing files, and operating browser tabs.",
    "",
    "Environment:",
    "- Planner + loop engine run in Chrome extension sidepanel/service worker.",
    "- Local WebSocket bridge is execution-only (file/shell proxy), not task planner.",
    "- You can operate live browser tabs via browser tools.",
    "",
    "Available tools:",
    tools,
    "",
    "Guidelines:",
    guidelines,
    "",
    `Current date and time: ${nowIso()}`,
    "Runtime: Browser extension agent (Chrome MV3)."
  ].join("\n");
}

function buildTaskProgressSystemMessage(input: {
  llmStep: number;
  maxLoopSteps: number;
  toolStep: number;
  retryAttempt: number;
  retryMaxAttempts: number;
}): string {
  const llmStep = Math.max(1, Number(input.llmStep || 1));
  const maxLoopSteps = Math.max(1, Number(input.maxLoopSteps || 1));
  const toolStep = Math.max(0, Number(input.toolStep || 0));
  const retryAttempt = Math.max(0, Number(input.retryAttempt || 0));
  const retryMaxAttempts = Math.max(0, Number(input.retryMaxAttempts || 0));
  return [
    "Task progress (brief):",
    `- loop_step: ${llmStep}/${maxLoopSteps}`,
    `- tool_steps_done: ${toolStep}`,
    `- retry_state: ${retryAttempt}/${retryMaxAttempts}`,
    "- Keep moving toward the same user goal; avoid repeating already completed steps."
  ].join("\n");
}

function buildLlmMessagesFromContext(
  config: BridgeConfig,
  meta: SessionMeta | null,
  contextMessages: SessionContextMessageLike[],
  previousSummary = "",
  availableSkillsPrompt = ""
): JsonRecord[] {
  const out: JsonRecord[] = [];
  out.push({
    role: "system",
    content: buildBrowserAgentSystemPrompt(config)
  });
  out.push({
    role: "system",
    content: [
      "Tool retry policy:",
      "1) For transient tool errors (retryable=true), retry the same goal with adjusted parameters.",
      "2) bash supports optional timeoutMs (milliseconds). Increase timeoutMs when timeout-related failures happen.",
      "3) For non-retryable errors, stop retrying and explain the blocker clearly.",
      "4) A short task progress note will be provided each round via system message.",
      "5) For browser tasks, prefer actions grounded in observed page state and tool results.",
      "6) Do not invent site selectors/URLs; re-observe when uncertain.",
      "7) File runtime routing policy: use mem:// or vfs:// path (or runtime=browser) for browser virtual files; use regular/absolute paths (or runtime=local) for local files.",
      "8) Temporary policy: do NOT run tests (e.g., bun test/pnpm test/npm test/pytest/go test) unless the user explicitly requests tests."
    ].join("\n")
  });
  const metadata = toRecord(meta?.header?.metadata);
  const sharedTabsContext = buildSharedTabsContextMessage(metadata.sharedTabs);
  if (sharedTabsContext) {
    out.push({
      role: "system",
      content: sharedTabsContext
    });
  }
  if (availableSkillsPrompt) {
    out.push({
      role: "system",
      content: availableSkillsPrompt
    });
  }

  const summaryMessage = buildCompactionSummaryLlmMessage(previousSummary);
  if (summaryMessage) out.push(summaryMessage);

  out.push(...convertSessionContextMessagesToLlm(contextMessages));

  if (out.filter((item) => String(item.role || "") !== "system").length === 0) {
    out.push({ role: "user", content: "继续当前任务。" });
  }

  return out;
}

function shouldVerifyStep(action: string, verifyPolicy: unknown): boolean {
  const policy = String(verifyPolicy || "on_critical");
  if (policy === "off") return false;
  if (policy === "always") return true;
  const critical = ["click", "type", "fill", "press", "scroll", "select", "navigate", "action"];
  return critical.includes(String(action || "").trim().toLowerCase());
}

function actionRequiresLease(kind: string): boolean {
  return ["click", "type", "fill", "press", "scroll", "select", "navigate", "hover"].includes(kind);
}

function shouldAcquireLease(kind: string, policy: CapabilityExecutionPolicy): boolean {
  const leasePolicy = policy.leasePolicy || "auto";
  if (leasePolicy === "none") return false;
  if (leasePolicy === "required") return true;
  return actionRequiresLease(kind);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLlmStatus(status: number): boolean {
  return [408, 409, 429, 500, 502, 503, 504].includes(Number(status || 0));
}

function computeRetryDelayMs(attempt: number): number {
  const base = 500;
  const cap = 4000;
  const next = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(cap, next);
}

function parseRetryAfterHeaderValue(raw: string): number | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  const delta = ts - Date.now();
  if (delta <= 0) return null;
  return Math.ceil(delta);
}

function extractRetryDelayHintMs(rawBody: string, resp: Response): number | null {
  const retryAfter = parseRetryAfterHeaderValue(String(resp.headers.get("retry-after") || ""));
  if (retryAfter !== null) return retryAfter;

  const xRateLimitReset = String(resp.headers.get("x-ratelimit-reset") || "").trim();
  if (xRateLimitReset) {
    const sec = Number.parseInt(xRateLimitReset, 10);
    if (Number.isFinite(sec)) {
      const delta = sec * 1000 - Date.now();
      if (delta > 0) return Math.ceil(delta);
    }
  }

  const xRateLimitResetAfter = String(resp.headers.get("x-ratelimit-reset-after") || "").trim();
  if (xRateLimitResetAfter) {
    const sec = Number(xRateLimitResetAfter);
    if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
  }

  const text = String(rawBody || "");
  const retryDelayField = /"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(text);
  if (retryDelayField) {
    const sec = Number(retryDelayField[1]);
    if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
  }

  const resetAfter = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(text);
  if (resetAfter) {
    const hours = resetAfter[1] ? Number.parseInt(resetAfter[1], 10) : 0;
    const minutes = resetAfter[2] ? Number.parseInt(resetAfter[2], 10) : 0;
    const seconds = Number(resetAfter[3]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(((hours * 60 + minutes) * 60 + seconds) * 1000);
    }
  }

  const retryIn = /retry in (\d+(?:\.\d+)?)\s*(ms|s)/i.exec(text);
  if (retryIn) {
    const amount = Number(retryIn[1]);
    if (Number.isFinite(amount) && amount > 0) {
      return Math.ceil(retryIn[2].toLowerCase() === "ms" ? amount : amount * 1000);
    }
  }

  return null;
}

function buildToolResponseEnvelope(type: string, data: unknown, extra: JsonRecord = {}): JsonRecord {
  return {
    type,
    response: { ok: true, data },
    ...extra
  };
}

function buildStepFailureEnvelope(
  toolName: string,
  out: ExecuteStepResult,
  fallbackError: string,
  retryHint: string,
  options: {
    defaultRetryable?: boolean;
    errorReason?: FailureReason;
    phase?: FailurePhase;
    category?: FailureCategory;
    modeEscalation?: JsonRecord | null;
    resumeStrategy?: ResumeStrategy;
    stepRef?: JsonRecord | null;
  } = {}
): JsonRecord {
  return attachFailureProtocol(toolName, {
    error: out.error || fallbackError,
    errorCode: normalizeErrorCode(out.errorCode) || undefined,
    errorReason: options.errorReason || "failed_execute",
    retryable: out.retryable === true,
    retryHint,
    details: out.errorDetails || null
  }, options);
}

function mapToolErrorReasonToTerminalStatus(rawReason: unknown): "failed_execute" | "failed_verify" | "progress_uncertain" {
  const reason = String(rawReason || "").trim().toLowerCase();
  if (reason === "failed_verify") return "failed_verify";
  if (reason === "progress_uncertain") return "progress_uncertain";
  return "failed_execute";
}

function mapVerifyReasonToFailureReason(rawVerifyReason: unknown): "failed_verify" | "progress_uncertain" {
  const verifyReason = String(rawVerifyReason || "").trim().toLowerCase();
  if (["verify_skipped", "verify_policy_off", "verify_not_supported_for_bridge", "verify_missing_tab_id"].includes(verifyReason)) {
    return "progress_uncertain";
  }
  return "failed_verify";
}

async function queryAllTabsForRuntime(): Promise<Array<{ id: number; windowId: number; index: number; active: boolean; pinned: boolean; title: string; url: string }>> {
  const tabs = await chrome.tabs.query({});
  return (tabs || [])
    .filter((tab) => Number.isInteger(tab?.id))
    .map((tab) => ({
      id: Number(tab.id),
      windowId: Number(tab.windowId || 0),
      index: Number(tab.index || 0),
      active: tab.active === true,
      pinned: tab.pinned === true,
      title: String(tab.title || ""),
      url: String(tab.url || tab.pendingUrl || "")
    }));
}

async function getActiveTabIdForRuntime(): Promise<number | null> {
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const active = focused.find((tab) => Number.isInteger(tab?.id));
  if (active?.id) return Number(active.id);
  const all = await queryAllTabsForRuntime();
  const first = all.find((tab) => Number.isInteger(tab.id));
  return first?.id || null;
}

function readSharedTabIds(sharedTabs: unknown): number[] {
  if (!Array.isArray(sharedTabs)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of sharedTabs) {
    const id = parsePositiveInt(toRecord(item).id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function callInfra(infra: RuntimeInfraHandler, message: JsonRecord): Promise<JsonRecord> {
  const result = await infra.handleMessage(message);
  if (!result) {
    const error = new Error(`unsupported infra message: ${String(message.type || "")}`) as RuntimeErrorWithMeta;
    error.code = "E_INFRA_UNSUPPORTED";
    throw error;
  }
  if (!result.ok) {
    const error = new Error(String(result.error || "infra call failed")) as RuntimeErrorWithMeta;
    const resultWithMeta = result as {
      code?: unknown;
      details?: unknown;
      retryable?: unknown;
      status?: unknown;
    };
    if (typeof resultWithMeta.code === "string" && resultWithMeta.code.trim()) {
      error.code = resultWithMeta.code.trim();
    }
    if (resultWithMeta.details !== undefined) {
      error.details = resultWithMeta.details;
    }
    if (typeof resultWithMeta.retryable === "boolean") {
      error.retryable = resultWithMeta.retryable;
    }
    if (Number.isFinite(Number(resultWithMeta.status))) {
      error.status = Number(resultWithMeta.status);
    }
    throw error;
  }
  return toRecord(result.data);
}

function extractLlmConfig(raw: JsonRecord): BridgeConfig {
  return {
    bridgeUrl: String(raw.bridgeUrl || ""),
    bridgeToken: String(raw.bridgeToken || ""),
    llmApiBase: String(raw.llmApiBase || ""),
    llmApiKey: String(raw.llmApiKey || ""),
    llmModel: String(raw.llmModel || "gpt-5.3-codex"),
    llmDefaultProfile: String(raw.llmDefaultProfile || "default"),
    llmProfiles: raw.llmProfiles,
    llmProfileChains: raw.llmProfileChains,
    llmEscalationPolicy: String(raw.llmEscalationPolicy || "upgrade_only"),
    llmSystemPromptCustom: String(raw.llmSystemPromptCustom || ""),
    maxSteps: normalizeIntInRange(raw.maxSteps, 100, 1, 500),
    autoTitleInterval: normalizeIntInRange(raw.autoTitleInterval, 10, 0, 100),
    bridgeInvokeTimeoutMs: normalizeIntInRange(raw.bridgeInvokeTimeoutMs, DEFAULT_BASH_TIMEOUT_MS, 1_000, MAX_BASH_TIMEOUT_MS),
    llmTimeoutMs: normalizeIntInRange(raw.llmTimeoutMs, DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS),
    llmRetryMaxAttempts: normalizeIntInRange(raw.llmRetryMaxAttempts, MAX_LLM_RETRIES, 0, 6),
    llmMaxRetryDelayMs: normalizeIntInRange(
      raw.llmMaxRetryDelayMs,
      DEFAULT_LLM_MAX_RETRY_DELAY_MS,
      MIN_LLM_MAX_RETRY_DELAY_MS,
      MAX_LLM_MAX_RETRY_DELAY_MS
    ),
    devAutoReload: raw.devAutoReload !== false,
    devReloadIntervalMs: Number(raw.devReloadIntervalMs || 1500)
  };
}

async function requestSessionTitleFromLlm(input: {
  providerRegistry: LlmProviderRegistry;
  route: LlmResolvedRoute;
  messages: { role: string; content: string }[];
}): Promise<string> {
  const { providerRegistry, route, messages } = input;
  if (!messages.length) return "";
  const provider = providerRegistry.get(String(route.provider || "").trim());
  if (!provider) return "";

  const systemPrompt = "你是一个专业助手。请根据提供的对话内容，生成一个非常简短、精准的标题（不超过 10 个字）。直接返回标题文本，不要包含引号、序号或任何解释。";
  const userContent = messages
    .slice(0, 5) // 取前 5 条消息以节省 token 并加速响应
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${clipText(m.content, 200)}`)
    .join("\n");

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("title-timeout"), Math.min(30_000, route.llmTimeoutMs));
    try {
      const response = await provider.send({
        route,
        signal: ctrl.signal,
        payload: {
          model: route.llmModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `请总结以下对话的标题：\n\n${userContent}` }
          ],
          max_tokens: 30,
          temperature: 0.3,
          stream: false
        }
      });
      if (!response.ok) return "";
      const contentType = String(response.headers.get("content-type") || "");
      const rawBody = await response.text();
      const message = parseLlmMessageFromBody(rawBody, contentType);
      const title = normalizeSessionTitle(parseLlmContent(message), "").trim();
      return title
        .replace(/^[`"'“”‘’《》「」()（）【】\s]+/, "")
        .replace(/[`"'“”‘’《》「」()（）【】\s]+$/, "")
        .slice(0, 20);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error("Failed to request session title:", err);
    return "";
  }
}

async function requestCompactionSummaryFromLlm(input: {
  orchestrator: BrainOrchestrator;
  infra: RuntimeInfraHandler;
  providerRegistry: LlmProviderRegistry;
  sessionId: string;
  mode: "history" | "turn_prefix";
  promptText: string;
  maxTokens: number;
}): Promise<string> {
  const cfgRaw = await callInfra(input.infra, { type: "config.get" });
  const config = extractLlmConfig(cfgRaw);
  const meta = await input.orchestrator.sessions.getMeta(input.sessionId);
  const prefs = readSessionLlmRoutePrefs(meta);
  const resolvedRoute = resolveLlmRoute({
    config,
    profile: prefs.profile,
    role: prefs.role,
    escalationPolicy: prefs.escalationPolicy
  });
  if (!resolvedRoute.ok) {
    throw new Error(resolvedRoute.message);
  }
  const route = resolvedRoute.route;
  const provider = input.providerRegistry.get(String(route.provider || "").trim());
  if (!provider) {
    throw new Error(`未找到 LLM provider: ${route.provider}`);
  }

  const llmModel = String(route.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex";
  const llmTimeoutMs = normalizeIntInRange(route.llmTimeoutMs, DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS);
  const llmRetryMaxAttempts = normalizeIntInRange(route.llmRetryMaxAttempts, MAX_LLM_RETRIES, 0, 6);
  const llmMaxRetryDelayMs = normalizeIntInRange(
    route.llmMaxRetryDelayMs,
    DEFAULT_LLM_MAX_RETRY_DELAY_MS,
    MIN_LLM_MAX_RETRY_DELAY_MS,
    MAX_LLM_MAX_RETRY_DELAY_MS
  );
  const baseUrl = provider.resolveRequestUrl(route);
  const basePayload: JsonRecord = {
    model: llmModel,
    messages: [
      { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: "user", content: String(input.promptText || "") }
    ],
    max_tokens: normalizeIntInRange(input.maxTokens, 2048, 128, 32768),
    temperature: 0.2,
    stream: false,
    reasoning: "high"
  };
  const totalAttempts = Math.max(1, llmRetryMaxAttempts + 1);

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const beforeRequest = await input.orchestrator.runHook("llm.before_request", {
        request: {
          sessionId: input.sessionId,
          step: 0,
          attempt,
          mode: input.mode,
          source: "compaction",
          url: baseUrl,
          payload: basePayload
        }
      });
      if (beforeRequest.blocked) {
        throw new Error(`llm.before_request blocked: ${beforeRequest.reason || "blocked"}`);
      }
      const patchedRequest = toRecord(beforeRequest.value.request);
      const requestUrl = String(patchedRequest.url || baseUrl).trim() || baseUrl;
      const requestPayload = toRecord(patchedRequest.payload);
      if (!Array.isArray(requestPayload.messages)) requestPayload.messages = basePayload.messages;
      if (!String(requestPayload.model || "").trim()) requestPayload.model = llmModel;
      if (typeof requestPayload.stream !== "boolean") requestPayload.stream = false;

      input.orchestrator.events.emit("llm.request", input.sessionId, {
        step: 0,
        attempt,
        mode: "compaction",
        summaryMode: input.mode,
        url: requestUrl,
        model: llmModel,
        profile: route.profile,
        provider: route.provider,
        ...summarizeLlmRequestPayload(requestPayload)
      });

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort("compaction-summary-timeout"), llmTimeoutMs);
      let response: Response;
      try {
        response = await provider.send({
          route,
          requestUrl,
          signal: ctrl.signal,
          payload: requestPayload
        });
      } finally {
        clearTimeout(timer);
      }

      const status = response.status;
      const ok = response.ok;
      const contentType = String(response.headers.get("content-type") || "");
      const rawBody = await response.text();
      const retryDelayHintMs = ok ? null : extractRetryDelayHintMs(rawBody, response);
      input.orchestrator.events.emit(
        "llm.response.raw",
        input.sessionId,
        buildLlmRawTracePayload({
          step: 0,
          attempt,
          status,
          ok,
          retryDelayHintMs,
          body: rawBody
        })
      );

      if (!ok) {
        if (attempt < totalAttempts && isRetryableLlmStatus(status)) {
          const delayMs = Math.max(
            0,
            Math.min(
              llmMaxRetryDelayMs > 0 ? llmMaxRetryDelayMs : Number.MAX_SAFE_INTEGER,
              retryDelayHintMs ?? computeRetryDelayMs(attempt)
            )
          );
          if (delayMs > 0) await delay(delayMs);
          continue;
        }
        const err = new Error(`Compaction summary HTTP ${status}`) as RuntimeErrorWithMeta;
        err.status = status;
        throw err;
      }

      const message = parseLlmMessageFromBody(rawBody, contentType);
      const afterResponse = await input.orchestrator.runHook("llm.after_response", {
        request: {
          sessionId: input.sessionId,
          step: 0,
          attempt,
          mode: input.mode,
          source: "compaction",
          url: requestUrl,
          payload: requestPayload,
          status,
          ok
        },
        response: message
      });
      if (afterResponse.blocked) {
        throw new Error(`llm.after_response blocked: ${afterResponse.reason || "blocked"}`);
      }
      const patchedResponse = toRecord(afterResponse.value.response);
      const summary = parseLlmContent(patchedResponse).trim();
      if (!summary) {
        throw new Error("Compaction summary 为空");
      }
      return summary;
    } catch (error) {
      if (attempt >= totalAttempts) throw error;
      const err = asRuntimeErrorWithMeta(error);
      const reason = String(err.message || "");
      if (reason.includes("llm.before_request blocked") || reason.includes("llm.after_response blocked")) {
        throw error;
      }
      if (reason.includes("Compaction summary 为空")) {
        throw error;
      }
      const status = Number(err.status || 0);
      const retryableStatus = Number.isInteger(status) && status > 0 ? isRetryableLlmStatus(status) : true;
      if (!retryableStatus) throw error;
      const fallbackDelayMs = Math.max(0, Math.min(llmMaxRetryDelayMs, computeRetryDelayMs(attempt)));
      if (fallbackDelayMs > 0) await delay(fallbackDelayMs);
    }
  }

  throw new Error("compaction summary 请求失败");
}

async function refreshSessionTitleAuto(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  infra: RuntimeInfraHandler,
  providerRegistry: LlmProviderRegistry,
  options: { force?: boolean } = {}
): Promise<void> {
  const meta = await orchestrator.sessions.getMeta(sessionId);
  if (!meta) return;
  const currentTitle = normalizeSessionTitle(meta.header.title, "");
  const titleSource = readSessionTitleSource(meta);
  if (titleSource === SESSION_TITLE_SOURCE_MANUAL && !options.force) {
    return;
  }
  
  const entries = await orchestrator.sessions.getEntries(sessionId);
  const contextMessages = entries
    .filter((entry) => entry.type === "message")
    .map((m: any) => ({ role: String(m.role), content: String(m.text || "") }))
    .filter((m) => m.content.trim().length > 0);

  const messageCount = contextMessages.length;
  if (messageCount === 0) return;

  const cfgRaw = await callInfra(infra, { type: "config.get" });
  const config = extractLlmConfig(cfgRaw);
  const prefs = readSessionLlmRoutePrefs(meta);
  const resolvedRoute = resolveLlmRoute({
    config,
    profile: prefs.profile,
    role: prefs.role,
    escalationPolicy: prefs.escalationPolicy
  });
  if (!resolvedRoute.ok) return;
  const route = resolvedRoute.route;
  const interval = config.autoTitleInterval;

  // 触发逻辑：
  // 1. 显式强制刷新 (options.force)
  // 2. 当前是默认标题 ("新会话")
  // 3. 消息数量是配置阈值 (interval) 的倍数，进行周期性重命名。如果 interval 为 0 则不自动重命名。
  const isDefaultTitle =
    !currentTitle || currentTitle === "新会话" || currentTitle === "新对话";
  const shouldRefresh = 
    options.force || 
    isDefaultTitle || 
    (interval > 0 && messageCount > 0 && messageCount % interval === 0);

  if (!shouldRefresh) return;

  const derived = await requestSessionTitleFromLlm({
    providerRegistry,
    route,
    messages: contextMessages
  });

  if (!derived) return;

  const nextMeta: SessionMeta = withSessionTitleMeta(meta, derived, SESSION_TITLE_SOURCE_AI);
  await writeSessionMeta(sessionId, nextMeta);
  orchestrator.events.emit("session_title_auto_updated", sessionId, { title: derived });
}

export function createRuntimeLoopController(orchestrator: BrainOrchestrator, infra: RuntimeInfraHandler): RuntimeLoopController {
  const llmProviders = new LlmProviderRegistry();
  llmProviders.register(createOpenAiCompatibleLlmProvider(DEFAULT_LLM_PROVIDER_ID), { replace: true });

  orchestrator.onHook(
    "compaction.summary",
    async (payload) => {
      const promptText = String(payload.promptText || "").trim();
      if (!promptText) {
        return { action: "block", reason: "compaction.summary prompt 为空" };
      }
      try {
        const summary = await requestCompactionSummaryFromLlm({
          orchestrator,
          infra,
          providerRegistry: llmProviders,
          sessionId: String(payload.sessionId || ""),
          mode: payload.mode === "turn_prefix" ? "turn_prefix" : "history",
          promptText,
          maxTokens: Number(payload.maxTokens || 0)
        });
        return {
          action: "patch",
          patch: {
            summary
          }
        };
      } catch (error) {
        return {
          action: "block",
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    },
    { id: "runtime-loop.compaction.summary", priority: 100 }
  );

  const bridgeCapabilityInvoker = async (input: {
    sessionId: string;
    capability: ExecuteCapability;
    args: JsonRecord;
  }): Promise<JsonRecord> => {
    const frame = (() => {
      const rawFrame = toRecord(input.args.frame);
      if (Object.keys(rawFrame).length === 0) {
        throw new Error(`bridge capability provider 需要 args.frame: ${input.capability}`);
      }
      return { ...rawFrame };
    })();
    if (!String(frame.tool || "").trim()) {
      throw new Error(`bridge capability provider 缺少 frame.tool: ${input.capability}`);
    }
    if (!frame.sessionId) frame.sessionId = input.sessionId;
    const response = await callInfra(infra, {
      type: "bridge.invoke",
      payload: frame
    });
    return {
      type: "invoke",
      response
    };
  };

  const virtualFsCapabilityInvoker = async (input: {
    sessionId: string;
    capability: ExecuteCapability;
    args: JsonRecord;
  }): Promise<JsonRecord> => {
    const frame = (() => {
      const rawFrame = toRecord(input.args.frame);
      if (Object.keys(rawFrame).length === 0) {
        throw new Error(`virtual fs capability provider 需要 args.frame: ${input.capability}`);
      }
      return { ...rawFrame };
    })();
    if (!String(frame.tool || "").trim()) {
      throw new Error(`virtual fs capability provider 缺少 frame.tool: ${input.capability}`);
    }
    if (!frame.sessionId) frame.sessionId = input.sessionId;
    const data = await invokeVirtualFrame(frame);
    return {
      type: "invoke",
      response: {
        ok: true,
        data
      }
    };
  };

  const ensureBuiltinBridgeCapabilityProviders = (): void => {
    for (const item of BUILTIN_BRIDGE_CAPABILITY_PROVIDERS) {
      const existed = orchestrator.getCapabilityProviders(item.capability).some((provider) => provider.id === item.providerId);
      if (existed) continue;
      orchestrator.registerCapabilityProvider(item.capability, {
        id: item.providerId,
        mode: "bridge",
        priority: -100,
        canHandle: (stepInput) => {
          const frame = toRecord(stepInput.args?.frame);
          if (String(frame.tool || "").trim().length === 0) return false;
          return !shouldRouteFrameToBrowserVfs(frame);
        },
        invoke: async (stepInput) =>
          bridgeCapabilityInvoker({
            sessionId: stepInput.sessionId,
            capability: item.capability,
            args: toRecord(stepInput.args)
          })
      });
    }
  };

  const ensureBuiltinVirtualFsCapabilityProviders = (): void => {
    for (const item of BUILTIN_VIRTUAL_FS_CAPABILITY_PROVIDERS) {
      const existed = orchestrator.getCapabilityProviders(item.capability).some((provider) => provider.id === item.providerId);
      if (existed) continue;
      orchestrator.registerCapabilityProvider(item.capability, {
        id: item.providerId,
        mode: "script",
        priority: -80,
        canHandle: (stepInput) => {
          const frame = toRecord(stepInput.args?.frame);
          if (String(frame.tool || "").trim().length === 0) return false;
          if (!shouldRouteFrameToBrowserVfs(frame)) return false;
          return frameMatchesVirtualCapability(frame, String(item.capability || ""));
        },
        invoke: async (stepInput) =>
          virtualFsCapabilityInvoker({
            sessionId: stepInput.sessionId,
            capability: item.capability,
            args: toRecord(stepInput.args)
          })
      });
    }
  };

  async function withTabLease<T>(tabId: number, sessionId: string, run: () => Promise<T>): Promise<T> {
    const acquired = await callInfra(infra, {
      type: "lease.acquire",
      tabId,
      sessionId,
      ttlMs: 30_000
    });
    if (acquired.ok !== true) {
      throw new Error(`lease.acquire 失败: ${String(acquired.reason || "unknown")}`);
    }

    try {
      return await run();
    } finally {
      await infra.handleMessage({
        type: "lease.release",
        tabId,
        sessionId
      });
    }
  }

  async function resolveRunScopeTabId(sessionId: string, explicitTabIdRaw: unknown): Promise<number | null> {
    const explicitTabId = parsePositiveInt(explicitTabIdRaw);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    const metadata = toRecord(toRecord(meta?.header).metadata);
    const currentPrimary = parsePositiveInt(metadata.primaryTabId);
    const sharedTabIds = readSharedTabIds(metadata.sharedTabs);

    let resolved = explicitTabId || currentPrimary;
    if (!resolved && sharedTabIds.length > 0) {
      resolved = sharedTabIds[0];
    }
    if (!resolved) {
      resolved = await getActiveTabIdForRuntime();
    }

    if (meta && resolved && currentPrimary !== resolved) {
      await writeSessionMeta(sessionId, {
        ...meta,
        header: {
          ...meta.header,
          metadata: {
            ...metadata,
            primaryTabId: resolved
          }
        }
      });
    }
    return resolved;
  }

  function createRuntimeError(message: string, meta: { code?: string; retryable?: boolean; details?: unknown } = {}): RuntimeErrorWithMeta {
    const error = new Error(message) as RuntimeErrorWithMeta;
    if (meta.code) error.code = meta.code;
    if (typeof meta.retryable === "boolean") error.retryable = meta.retryable;
    if (meta.details !== undefined) error.details = meta.details;
    return error;
  }

  const invokeBrowserSnapshotCapability = async (stepInput: {
    sessionId: string;
    action: string;
    args: JsonRecord;
  }): Promise<unknown> => {
    const payload = toRecord(stepInput.args);
    const options = toRecord(payload.options);
    const tabId = parsePositiveInt(payload.tabId || options.tabId);
    if (!tabId) {
      throw createRuntimeError("snapshot 需要有效 tabId", {
        code: "E_NO_TAB",
        retryable: true
      });
    }
    return await callInfra(infra, {
      type: "cdp.snapshot",
      tabId,
      options: Object.keys(options).length > 0 ? options : payload
    });
  };

  const invokeBrowserActionCapability = async (stepInput: {
    sessionId: string;
    action: string;
    args: JsonRecord;
    verifyPolicy?: StepVerifyPolicy;
    capability?: ExecuteCapability;
  }): Promise<unknown> => {
    const payload = toRecord(stepInput.args);
    const actionPayload = toRecord(payload.action) && Object.keys(toRecord(payload.action)).length > 0 ? toRecord(payload.action) : payload;
    const tabId = parsePositiveInt(payload.tabId || actionPayload.tabId);
    if (!tabId) {
      throw createRuntimeError("cdp 执行需要有效 tabId", {
        code: "E_NO_TAB",
        retryable: true
      });
    }

    const cdpAction = Object.keys(toRecord(payload.action)).length > 0 ? { ...toRecord(payload.action) } : { ...payload };
    if (!cdpAction.kind && stepInput.action && !stepInput.action.startsWith("cdp.")) {
      cdpAction.kind = stepInput.action;
    }
    const kind = String(cdpAction.kind || "").trim();
    if (!kind) {
      throw createRuntimeError("cdp.action 缺少 kind", {
        code: "E_ARGS",
        retryable: false
      });
    }

    const capabilityPolicy = orchestrator.resolveCapabilityPolicy(stepInput.capability);
    const verifyPolicy = stepInput.verifyPolicy || capabilityPolicy.defaultVerifyPolicy || "on_critical";
    const verifyEnabled = shouldVerifyStep(kind, verifyPolicy);
    let preObserve: unknown = null;
    if (verifyEnabled) {
      preObserve = await callInfra(infra, {
        type: "cdp.observe",
        tabId
      }).catch(() => null);
    }

    const actionResult = shouldAcquireLease(kind, capabilityPolicy)
      ? await withTabLease(tabId, stepInput.sessionId, async () => {
          return await callInfra(infra, {
            type: "cdp.action",
            tabId,
            sessionId: stepInput.sessionId,
            action: cdpAction
          });
        })
      : await callInfra(infra, {
          type: "cdp.action",
          tabId,
          sessionId: stepInput.sessionId,
          action: cdpAction
        });

    let verified = false;
    let verifyReason = "verify_policy_off";
    let verifyData: unknown = null;
    if (verifyEnabled) {
      try {
        const explicitExpect = normalizeVerifyExpect(payload.expect || actionPayload.expect || null);
        if (explicitExpect) {
          if (explicitExpect.urlChanged === true && toRecord(toRecord(preObserve).page).url) {
            explicitExpect.previousUrl = String(toRecord(toRecord(preObserve).page).url || "");
          }
          verifyData = await callInfra(infra, {
            type: "cdp.verify",
            tabId,
            action: { expect: explicitExpect },
            result: toRecord(actionResult).result || actionResult
          });
        } else if (preObserve) {
          const afterObserve = await callInfra(infra, {
            type: "cdp.observe",
            tabId
          });
          verifyData = buildObserveProgressVerify(preObserve, afterObserve);
        }
      } catch (verifyError) {
        const runtimeVerifyError = asRuntimeErrorWithMeta(verifyError);
        throw createRuntimeError(runtimeVerifyError.message, {
          code: normalizeErrorCode(runtimeVerifyError.code) || "E_VERIFY_EXECUTE",
          retryable: true,
          details: runtimeVerifyError.details
        });
      }

      verified = toRecord(verifyData).ok === true;
      verifyReason = verifyData ? (verified ? "verified" : "verify_failed") : "verify_skipped";
    }

    let data: unknown = actionResult;
    if (verifyData && data && typeof data === "object" && !Array.isArray(data)) {
      data = {
        ...(data as JsonRecord),
        verify: verifyData
      };
    }

    return {
      data,
      verified,
      verifyReason
    };
  };

  const invokeBrowserVerifyCapability = async (stepInput: {
    sessionId: string;
    action: string;
    args: JsonRecord;
  }): Promise<unknown> => {
    const payload = toRecord(stepInput.args);
    const tabId = parsePositiveInt(payload.tabId || toRecord(payload.action).tabId);
    if (!tabId) {
      throw createRuntimeError("browser_verify 需要有效 tabId", {
        code: "E_NO_TAB",
        retryable: true
      });
    }
    const verifyAction = Object.keys(toRecord(payload.action)).length
      ? toRecord(payload.action)
      : {
          expect: Object.keys(toRecord(payload.expect)).length ? toRecord(payload.expect) : payload
        };
    const verifyData = await callInfra(infra, {
      type: "cdp.verify",
      tabId,
      action: verifyAction,
      result: payload.result || null
    });
    const verified = toRecord(verifyData).ok === true;
    return {
      data: verifyData,
      verified,
      verifyReason: verified ? "verified" : "verify_failed"
    };
  };

  const ensureBuiltinBrowserCapabilityProviders = (): void => {
    for (const item of BUILTIN_BROWSER_CAPABILITY_PROVIDERS) {
      const existed = orchestrator.getCapabilityProviders(item.capability).some((provider) => provider.id === item.providerId);
      if (existed) continue;
      orchestrator.registerCapabilityProvider(item.capability, {
        id: item.providerId,
        mode: "cdp",
        priority: -100,
        invoke: async (stepInput) => {
          const input = {
            sessionId: stepInput.sessionId,
            action: String(stepInput.action || "").trim(),
            args: toRecord(stepInput.args),
            verifyPolicy: stepInput.verifyPolicy,
            capability: stepInput.capability
          };
          if (item.capability === TOOL_CAPABILITIES.search_elements) {
            return await invokeBrowserSnapshotCapability(input);
          }
          if (item.capability === TOOL_CAPABILITIES.click) {
            return await invokeBrowserActionCapability(input);
          }
          return await invokeBrowserVerifyCapability(input);
        }
      });
    }
  };

  ensureBuiltinBridgeCapabilityProviders();
  ensureBuiltinVirtualFsCapabilityProviders();
  ensureBuiltinBrowserCapabilityProviders();

  async function executeStep(input: {
    sessionId: string;
    mode?: ExecuteMode;
    capability?: ExecuteCapability;
    action: string;
    args?: JsonRecord;
    verifyPolicy?: StepVerifyPolicy;
  }): Promise<ExecuteStepResult> {
    const sessionId = String(input.sessionId || "").trim();
    const normalizedMode = ["script", "cdp", "bridge"].includes(String(input.mode || "").trim())
      ? (String(input.mode || "").trim() as ExecuteMode)
      : undefined;
    const normalizedCapability = String(input.capability || "").trim() || undefined;
    const capabilityPolicy = orchestrator.resolveCapabilityPolicy(normalizedCapability);
    const effectiveVerifyPolicy: StepVerifyPolicy = input.verifyPolicy || capabilityPolicy.defaultVerifyPolicy || "on_critical";
    const normalizedAction = String(input.action || "").trim();
    const payload = toRecord(input.args);
    const actionPayload = toRecord(payload.action) && Object.keys(toRecord(payload.action)).length > 0 ? toRecord(payload.action) : payload;
    const tabId = parsePositiveInt(payload.tabId || actionPayload.tabId);

    if (!normalizedMode && !normalizedCapability) {
      return { ok: false, modeUsed: "bridge", verified: false, error: "mode 或 capability 至少需要一个" };
    }
    if (!normalizedAction) {
      return { ok: false, modeUsed: normalizedMode || "bridge", verified: false, error: "action 不能为空" };
    }

    if (normalizedCapability && orchestrator.hasCapabilityProvider(normalizedCapability)) {
      const capabilityMode = normalizedMode || orchestrator.resolveModeForCapability(normalizedCapability);
      if (!capabilityMode) {
        const result: ExecuteStepResult = {
          ok: false,
          modeUsed: "bridge",
          capabilityUsed: normalizedCapability,
          verified: false,
          error: `capability provider 已注册但缺少 mode: ${normalizedCapability}`,
          errorCode: "E_RUNTIME_NOT_READY",
          retryable: true
        };
        orchestrator.events.emit("step_execute", sessionId, {
          mode: "bridge",
          capability: normalizedCapability,
          action: normalizedAction
        });
        orchestrator.events.emit("step_execute_result", sessionId, {
          ok: result.ok,
          modeUsed: result.modeUsed,
          capabilityUsed: result.capabilityUsed || "",
          verifyReason: result.verifyReason || "",
          verified: result.verified,
          error: result.error || "",
          errorCode: result.errorCode || "",
          retryable: result.retryable === true
        });
        return result;
      }
      orchestrator.events.emit("step_execute", sessionId, {
        mode: capabilityMode,
        capability: normalizedCapability,
        action: normalizedAction
      });
      const result = await orchestrator.executeStep({
        sessionId,
        mode: capabilityMode,
        capability: normalizedCapability,
        action: normalizedAction,
        args: payload,
        verifyPolicy: effectiveVerifyPolicy
      });
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        capabilityUsed: result.capabilityUsed || normalizedCapability,
        fallbackFrom: result.fallbackFrom,
        verified: result.verified,
        verifyReason: result.verifyReason,
        error: result.error
      });
      return {
        ...result,
        capabilityUsed: result.capabilityUsed || normalizedCapability
      };
    }

    if (normalizedCapability) {
      const result: ExecuteStepResult = {
        ok: false,
        modeUsed: "bridge",
        capabilityUsed: normalizedCapability,
        verified: false,
        error: `capability provider 未就绪: ${normalizedCapability}`,
        errorCode: "E_RUNTIME_NOT_READY",
        retryable: true
      };
      orchestrator.events.emit("step_execute", sessionId, {
        mode: "bridge",
        capability: normalizedCapability,
        action: normalizedAction
      });
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        capabilityUsed: result.capabilityUsed || "",
        verifyReason: result.verifyReason || "",
        verified: result.verified,
        error: result.error || "",
        errorCode: result.errorCode || "",
        retryable: result.retryable === true
      });
      return result;
    }

    const executionMode = normalizedMode;
    if (!executionMode) {
      return {
        ok: false,
        modeUsed: "bridge",
        verified: false,
        error: normalizedCapability
          ? `capability provider 未注册或未就绪: ${normalizedCapability}`
          : "mode 必须是 script/cdp/bridge"
      };
    }

    orchestrator.events.emit("step_execute", sessionId, {
      mode: executionMode,
      capability: normalizedCapability,
      action: normalizedAction
    });

    const runMode = async (targetMode: ExecuteMode): Promise<unknown> => {
      if (targetMode === "bridge") {
        const frame: JsonRecord = (() => {
          const rawFrame = toRecord(payload.frame);
          if (Object.keys(rawFrame).length > 0) return { ...rawFrame };
          return {
            tool: String(payload.tool || normalizedAction || "").trim(),
            args: Object.keys(toRecord(payload.invokeArgs)).length > 0 ? toRecord(payload.invokeArgs) : toRecord(payload.args)
          };
        })();
        if (!String(frame.tool || "").trim()) throw new Error("bridge 执行缺少 tool");
        if (!frame.sessionId) frame.sessionId = sessionId;
        const response = await callInfra(infra, {
          type: "bridge.invoke",
          payload: frame
        });
        return {
          type: "invoke",
          response
        };
      }

      if (!tabId) throw new Error(`${targetMode} 执行需要有效 tabId`);

      if (normalizedAction === "snapshot" || normalizedAction === "cdp.snapshot") {
        return await callInfra(infra, {
          type: "cdp.snapshot",
          tabId,
          options: toRecord(payload.options) && Object.keys(toRecord(payload.options)).length > 0 ? toRecord(payload.options) : payload
        });
      }
      if (normalizedAction === "observe" || normalizedAction === "cdp.observe") {
        return await callInfra(infra, {
          type: "cdp.observe",
          tabId
        });
      }
      if (normalizedAction === "verify" || normalizedAction === "cdp.verify") {
        const verifyAction = Object.keys(toRecord(payload.action)).length
          ? toRecord(payload.action)
          : {
              expect: Object.keys(toRecord(payload.expect)).length ? toRecord(payload.expect) : payload
            };
        return await callInfra(infra, {
          type: "cdp.verify",
          tabId,
          action: verifyAction,
          result: payload.result || null
        });
      }

      if (targetMode === "script") {
        const expression = String(payload.expression || payload.script || "").trim();
        if (!expression) throw new Error("script 模式缺少 expression");
        return await callInfra(infra, {
          type: "cdp.execute",
          tabId,
          action: {
            type: "runtime.evaluate",
            expression,
            returnByValue: payload.returnByValue !== false
          }
        });
      }

      const cdpAction = Object.keys(toRecord(payload.action)).length > 0 ? { ...toRecord(payload.action) } : { ...payload };
      if (!cdpAction.kind && normalizedAction && !normalizedAction.startsWith("cdp.")) {
        cdpAction.kind = normalizedAction;
      }
      const kind = String(cdpAction.kind || "").trim();
      if (!kind) throw new Error("cdp.action 缺少 kind");

      if (shouldAcquireLease(kind, capabilityPolicy)) {
        return await withTabLease(tabId, sessionId, async () => {
          return await callInfra(infra, {
            type: "cdp.action",
            tabId,
            sessionId,
            action: cdpAction
          });
        });
      }

      return await callInfra(infra, {
        type: "cdp.action",
        tabId,
        sessionId,
        action: cdpAction
      });
    };

    let modeUsed: ExecuteMode = executionMode;
    const fallbackFrom: ExecuteMode | undefined = undefined;
    let data: unknown;
    let preObserve: unknown = null;
    const verifyEnabled = shouldVerifyStep(String(actionPayload.kind || normalizedAction), effectiveVerifyPolicy);

    if (verifyEnabled && tabId && executionMode !== "bridge" && normalizedAction !== "verify" && normalizedAction !== "cdp.verify") {
      preObserve = await callInfra(infra, {
        type: "cdp.observe",
        tabId
      }).catch(() => null);
    }

    try {
      data = await runMode(executionMode);
    } catch (error) {
      const runtimeError = asRuntimeErrorWithMeta(error);
      const result: ExecuteStepResult = {
        ok: false,
        modeUsed,
        capabilityUsed: normalizedCapability,
        verified: false,
        error: runtimeError.message,
        errorCode: normalizeErrorCode(runtimeError.code),
        errorDetails: runtimeError.details,
        retryable: runtimeError.retryable
      };
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        capabilityUsed: result.capabilityUsed || "",
        verifyReason: result.verifyReason || "",
        verified: result.verified,
        error: result.error || "",
        errorCode: result.errorCode || "",
        retryable: result.retryable === true
      });
      return result;
    }

    let verified = false;
    let verifyReason = "verify_policy_off";
    try {
      if (verifyEnabled) {
        if (modeUsed === "bridge") {
          verifyReason = "verify_not_supported_for_bridge";
        } else if (!tabId) {
          verifyReason = "verify_missing_tab_id";
        } else if (normalizedAction === "verify" || normalizedAction === "cdp.verify") {
          verified = toRecord(data).ok === true;
          verifyReason = verified ? "verified" : "verify_failed";
        } else {
          const explicitExpect = normalizeVerifyExpect(payload.expect || actionPayload.expect || null);
          let verifyData: unknown = null;
          if (explicitExpect) {
            if (explicitExpect.urlChanged === true && toRecord(toRecord(preObserve).page).url) {
              explicitExpect.previousUrl = String(toRecord(toRecord(preObserve).page).url || "");
            }
            verifyData = await callInfra(infra, {
              type: "cdp.verify",
              tabId,
              action: { expect: explicitExpect },
              result: toRecord(data).result || data
            });
          } else if (preObserve) {
            const afterObserve = await callInfra(infra, {
              type: "cdp.observe",
              tabId
            });
            verifyData = buildObserveProgressVerify(preObserve, afterObserve);
          }

          verified = toRecord(verifyData).ok === true;
          verifyReason = verifyData ? (verified ? "verified" : "verify_failed") : "verify_skipped";
          if (verifyData && data && typeof data === "object" && !Array.isArray(data)) {
            data = {
              ...(data as JsonRecord),
              verify: verifyData
            };
          }
        }
      }
    } catch (verifyError) {
      const runtimeVerifyError = asRuntimeErrorWithMeta(verifyError);
      const result: ExecuteStepResult = {
        ok: false,
        modeUsed,
        fallbackFrom,
        verified: false,
        error: runtimeVerifyError.message,
        errorCode: normalizeErrorCode(runtimeVerifyError.code) || "E_VERIFY_EXECUTE",
        errorDetails: runtimeVerifyError.details,
        retryable: true
      };
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        fallbackFrom: result.fallbackFrom || "",
        verifyReason: result.verifyReason || "",
        verified: result.verified,
        error: result.error || "",
        errorCode: result.errorCode || "",
        retryable: result.retryable === true
      });
      return result;
    }

    const result: ExecuteStepResult = {
      ok: true,
      modeUsed,
      capabilityUsed: normalizedCapability,
      fallbackFrom,
      verified,
      verifyReason,
      data
    };
    orchestrator.events.emit("step_execute_result", sessionId, {
      ok: result.ok,
      modeUsed: result.modeUsed,
      capabilityUsed: result.capabilityUsed || "",
      fallbackFrom: result.fallbackFrom || "",
      verifyReason: result.verifyReason || "",
      verified: result.verified
    });
    return result;
  }

  function extractSkillReadContent(data: unknown): string {
    const root = toRecord(data);
    const rootData = toRecord(root.data);
    const rootResponse = toRecord(root.response);
    const rootResponseData = toRecord(rootResponse.data);
    const rootResponseInnerData = toRecord(rootResponseData.data);
    const rootResult = toRecord(root.result);
    const candidates: unknown[] = [
      data,
      root.content,
      root.text,
      rootData.content,
      rootData.text,
      rootResponse.content,
      rootResponse.text,
      rootResponseData.content,
      rootResponseData.text,
      rootResponseInnerData.content,
      rootResponseInnerData.text,
      rootResult.content,
      rootResult.text
    ];
    for (const item of candidates) {
      if (typeof item === "string") return item;
    }
    throw new Error(`read_file 未返回 content 文本: ${safeStringify(data, 1200)}`);
  }

  orchestrator.setSkillContentReader(async (input) => {
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) {
      throw new Error("skill.resolve 需要 sessionId 以绑定当前会话 capability");
    }
    const location = String(input.location || "").trim();
    const runtime = isVirtualUri(location) ? "browser" : undefined;
    const readCapability = String(input.capability || TOOL_CAPABILITIES.read_file).trim() || TOOL_CAPABILITIES.read_file;
    const result = await executeStep({
      sessionId,
      capability: readCapability as ExecuteCapability,
      action: "invoke",
      args: {
        path: location,
        frame: {
          tool: "read",
          args: {
            path: location,
            ...(runtime ? { runtime } : {})
          }
        }
      },
      verifyPolicy: "off"
    });
    if (!result.ok) {
      throw new Error(result.error || `read_file 失败: ${location}`);
    }
    return extractSkillReadContent(result.data);
  });

  async function invokeBridgeFrameWithRetry(
    sessionId: string,
    toolName: string,
    frame: JsonRecord,
    capability: ExecuteCapability | undefined,
    autoRetryMax = TOOL_AUTO_RETRY_MAX
  ): Promise<JsonRecord> {
    const invokeId = String(frame.id || `invoke-${crypto.randomUUID()}`);
    const frameWithInvokeId: JsonRecord = {
      ...frame,
      id: invokeId
    };
    const totalAttempts = Math.max(1, autoRetryMax + 1);
    let lastFailure: ExecuteStepResult | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const invoke = await executeStep({
        sessionId,
        capability,
        action: "invoke",
        args: {
          frame: frameWithInvokeId
        }
      });
      if (invoke.ok) {
        return buildToolResponseEnvelope("invoke", invoke.data, {
          capabilityUsed: invoke.capabilityUsed || capability,
          modeUsed: invoke.modeUsed,
          attempt,
          autoRetried: attempt > 1
        });
      }

      lastFailure = invoke;
      const code = normalizeErrorCode(invoke.errorCode);
      const canAutoRetry = attempt < totalAttempts && shouldAutoReplayToolCall(toolName, code);
      if (!canAutoRetry) break;
      await delay(computeToolRetryDelayMs(attempt));
    }

    const failure = lastFailure || {
      ok: false,
      modeUsed: "bridge" as ExecuteMode,
      verified: false,
      error: `${toolName} 执行失败`
    };
    const errorCode = normalizeErrorCode(failure.errorCode);
    return {
      error: failure.error || `${toolName} 执行失败`,
      errorCode: errorCode || undefined,
      errorReason: "failed_execute",
      retryable: failure.retryable === true || isRetryableToolErrorCode(toolName, errorCode),
      retryHint: buildToolRetryHint(toolName, errorCode),
      details: failure.errorDetails || null
    };
  }

  interface ResolvedToolCallContext {
    requestedTool: string;
    resolvedTool: string;
    executionTool: string;
    args: JsonRecord;
  }

  type ToolPlan =
    | {
        kind: "bridge";
        toolName: "bash" | "read_file" | "write_file" | "edit_file";
        capability: ExecuteCapability;
        frame: JsonRecord;
      }
    | {
        kind: "local.get_all_tabs";
      }
    | {
        kind: "local.current_tab";
      }
    | {
        kind: "local.create_new_tab";
        args: JsonRecord;
      }
    | {
        kind: "local.get_tab_info";
        tabId: number;
      }
    | {
        kind: "local.close_tab";
        tabId: number | null;
      }
    | {
        kind: "local.ungroup_tabs";
        windowId: number | null;
      }
    | {
        kind: "local.list_interventions";
        enabledOnly: boolean;
      }
    | {
        kind: "local.get_intervention_info";
        interventionType: string;
      }
    | {
        kind: "local.request_intervention";
        sessionId: string;
        interventionType: string;
        params: JsonRecord;
        timeoutSec: number;
        reason: string;
      }
    | {
        kind: "local.cancel_intervention";
        sessionId: string;
        requestId: string;
      }
    | {
        kind: "local.list_skills";
        enabledOnly: boolean;
      }
    | {
        kind: "local.get_skill_info";
        skillName: string;
      }
    | {
        kind: "local.load_skill";
        sessionId: string;
        skillName: string;
      }
    | {
        kind: "local.read_skill_reference";
        sessionId: string;
        skillName: string;
        refPath: string;
      }
    | {
        kind: "local.get_skill_asset";
        sessionId: string;
        skillName: string;
        assetPath: string;
      }
    | {
        kind: "local.execute_skill_script";
        sessionId: string;
        skillName: string;
        scriptPath: string;
        scriptArgs: unknown;
      }
    | {
        kind: "step.search_elements";
        capability: ExecuteCapability;
        tabId: number;
        options: JsonRecord;
        query: string;
        maxResults: number;
      }
    | {
        kind: "step.element_action";
        toolName:
          | "click"
          | "fill_element_by_uid"
          | "select_option_by_uid"
          | "hover_element_by_uid"
          | "get_editor_value"
          | "press_key"
          | "scroll_page"
          | "navigate_tab"
          | "scroll_to_element";
        capability: ExecuteCapability;
        tabId: number;
        kindValue: string;
        action: JsonRecord;
        expect: unknown;
      }
    | {
        kind: "step.script_action";
        toolName:
          | "get_page_metadata"
          | "highlight_element"
          | "highlight_text_inline";
        capability: ExecuteCapability;
        tabId: number;
        expression: string;
        expect: JsonRecord | null;
      }
    | {
        kind: "step.capture_screenshot";
        toolName:
          | "capture_screenshot"
          | "capture_tab_screenshot"
          | "capture_screenshot_with_highlight";
        tabId: number;
        format: "png" | "jpeg";
        quality: number | null;
        selector: string;
        sendToLLM: boolean;
      }
    | {
        kind: "step.download_image";
        tabId: number;
        imageData: string;
        filename: string;
      }
    | {
        kind: "step.download_chat_images";
        tabId: number;
        files: Array<{
          imageData: string;
          filename: string;
        }>;
      }
    | {
        kind: "step.computer";
        tabId: number;
        action: string;
        coordinate: [number, number] | null;
        startCoordinate: [number, number] | null;
        text: string;
        scrollDirection: string;
        scrollAmount: number | null;
        durationSec: number | null;
        uid: string;
        selector: string;
      }
    | {
        kind: "step.fill_form";
        capability: ExecuteCapability;
        tabId: number;
        elements: Array<{
          uid: string;
          ref: string;
          selector: string;
          backendNodeId: number | null;
          value: string;
        }>;
        submit: JsonRecord | null;
        expect: JsonRecord;
      }
    | {
        kind: "step.browser_verify";
        capability: ExecuteCapability;
        tabId: number;
        verifyExpect: JsonRecord;
      };

  function buildUnsupportedToolError(input: {
    requestedTool: string;
    resolvedTool: string;
    hasContract: boolean;
  }): JsonRecord {
    const unsupported = input.hasContract;
    return attachFailureProtocol(input.requestedTool || input.resolvedTool || "unknown_tool", {
      error: unsupported
        ? `工具已注册但当前 runtime 不支持执行: ${input.requestedTool}`
        : `未知工具: ${input.requestedTool}`,
      errorCode: unsupported ? "E_TOOL_UNSUPPORTED" : "E_TOOL",
      errorReason: "failed_execute",
      retryable: unsupported,
      retryHint: unsupported
        ? "Call a supported canonical tool name from tool list."
        : "Use list of available tools and retry with valid name.",
      details: {
        requestedTool: input.requestedTool,
        resolvedTool: input.resolvedTool,
        canonicalTool: input.resolvedTool || null,
        supportedTools: Array.from(RUNTIME_EXECUTABLE_TOOL_NAMES)
      }
    }, {
      phase: "plan",
      category: "missing_target",
      resumeStrategy: unsupported ? "replan" : "replan"
    });
  }

  function resolveToolCallContext(toolCall: ToolCallItem): { ok: true; value: ResolvedToolCallContext } | { ok: false; error: JsonRecord } {
    const requestedTool = String(toolCall.function.name || "").trim();
    const argsRaw = String(toolCall.function.arguments || "").trim();
    let args: JsonRecord = {};
    if (argsRaw) {
      try {
        args = toRecord(JSON.parse(argsRaw));
      } catch (error) {
        return {
          ok: false,
          error: { error: `参数解析失败: ${error instanceof Error ? error.message : String(error)}` }
        };
      }
    }

    const contract = orchestrator.resolveToolContract(requestedTool);
    const resolvedTool = String(contract?.name || requestedTool).trim();
    const executionTool = RUNTIME_EXECUTABLE_TOOL_NAMES.has(resolvedTool) ? resolvedTool : "";
    if (!executionTool) {
      return {
        ok: false,
        error: buildUnsupportedToolError({
          requestedTool,
          resolvedTool,
          hasContract: Boolean(contract)
        })
      };
    }

    return {
      ok: true,
      value: {
        requestedTool,
        resolvedTool,
        executionTool,
        args
      }
    };
  }

  const INTERVENTION_CATALOG: Record<
    string,
    {
      type: string;
      name: string;
      description: string;
      enabled: boolean;
      inputSchema: JsonRecord;
    }
  > = {
    "monitor-operation": {
      type: "monitor-operation",
      name: "Monitor Operation",
      description: "Ask user to watch/confirm a browser operation before continuing.",
      enabled: true,
      inputSchema: { type: "object", properties: { instruction: { type: "string" } } }
    },
    "voice-input": {
      type: "voice-input",
      name: "Voice Input",
      description: "Ask user to provide missing information via voice/text.",
      enabled: true,
      inputSchema: { type: "object", properties: { prompt: { type: "string" } } }
    },
    "user-selection": {
      type: "user-selection",
      name: "User Selection",
      description: "Ask user to choose one option from AI-provided candidates.",
      enabled: true,
      inputSchema: { type: "object", properties: { options: { type: "array" } } }
    }
  };

  const interventionRequests = new Map<
    string,
    {
      id: string;
      sessionId: string;
      type: string;
      params: JsonRecord;
      reason: string;
      timeoutSec: number;
      status: "pending" | "cancelled";
      createdAt: string;
    }
  >();

  function normalizeInterventionType(raw: unknown): string {
    const type = String(raw || "").trim().toLowerCase();
    if (!type) return "";
    return type;
  }

  function buildSkillChildLocation(location: string, relativePath: string): string {
    const normalizedLocation = String(location || "").trim();
    const normalizedRelative = String(relativePath || "")
      .trim()
      .replace(/^\.\//, "")
      .replace(/^\/+/, "");
    if (!normalizedLocation) return "";
    if (!normalizedRelative) return "";
    if (normalizedRelative.includes("..")) {
      throw new Error("skill path 不能包含 ..");
    }
    const cut = normalizedLocation.lastIndexOf("/");
    const base = cut >= 0 ? normalizedLocation.slice(0, cut) : normalizedLocation;
    return `${base}/${normalizedRelative}`;
  }

  async function resolveSkillByName(skillName: string): Promise<SkillMetadata | null> {
    const normalized = String(skillName || "").trim();
    if (!normalized) return null;
    const byId = await orchestrator.getSkill(normalized);
    if (byId) return byId;
    const all = await orchestrator.listSkills();
    const needle = normalized.toLowerCase();
    return (
      all.find((item) => String(item.id || "").toLowerCase() === needle) ||
      all.find((item) => String(item.name || "").toLowerCase() === needle) ||
      null
    );
  }

  async function readTextByLocation(sessionId: string, location: string): Promise<string> {
    const runtimeHint = isVirtualUri(location) ? "browser" : "local";
    const result = await executeStep({
      sessionId,
      capability: TOOL_CAPABILITIES.read_file,
      action: "invoke",
      args: {
        path: location,
        runtime: runtimeHint,
        frame: {
          tool: "read",
          args: {
            path: location,
            runtime: runtimeHint
          }
        }
      },
      verifyPolicy: "off"
    });
    if (!result.ok) {
      throw new Error(result.error || `read_file 失败: ${location}`);
    }
    return extractSkillReadContent(result.data);
  }

  function normalizeDownloadFilename(input: string, fallback: string): string {
    const name = String(input || "").trim();
    const base = (name || fallback)
      .replace(/[\\/:*?\"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    return base || fallback;
  }

  function shellQuote(input: string): string {
    return `'${String(input || "").replace(/'/g, "'\"'\"'")}'`;
  }

  function toCoordinatePair(raw: unknown): [number, number] | null {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
  }

  async function buildToolPlan(
    sessionId: string,
    context: ResolvedToolCallContext
  ): Promise<{ ok: true; plan: ToolPlan } | { ok: false; error: JsonRecord }> {
    const args = context.args;
    const buildUidActionPlan = async (
      toolName: string,
      kindValue: "click" | "fill" | "select" | "hover" | "read",
      options: {
        requireValue?: boolean;
      } = {}
    ): Promise<{ ok: true; plan: ToolPlan } | { ok: false; error: JsonRecord }> => {
      const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
      if (!tabId) {
        return {
          ok: false,
          error: attachFailureProtocol(toolName, {
            error: `${toolName} 需要 tabId，当前无可用 tab`,
            errorCode: "E_NO_TAB",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: `Call get_all_tabs and retry ${toolName} with a valid tabId.`
          }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
        };
      }
      const uid = String(args.uid || "").trim();
      const ref = String(args.ref || "").trim();
      const selector = String(args.selector || "").trim();
      const backendNodeId = parsePositiveInt(args.backendNodeId);
      if (!uid && !ref && !backendNodeId) {
        return {
          ok: false,
          error: attachFailureProtocol(toolName, {
            error: "元素交互动作需要 uid/ref/backendNodeId。请先调用 search_elements，再用返回的 uid 执行。",
            errorCode: "E_REF_REQUIRED",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: `Call search_elements first, then retry ${toolName} using uid/ref.`
          }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
        };
      }
      const value = args.value == null ? "" : String(args.value);
      if (options.requireValue === true && !value.trim()) {
        return {
          ok: false,
          error: attachFailureProtocol(toolName, {
            error: `${toolName} 需要非空 value`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: `Provide value and retry ${toolName}.`
          }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
        };
      }
      return {
        ok: true,
        plan: {
          kind: "step.element_action",
          toolName: toolName as
            | "click"
            | "fill_element_by_uid"
            | "select_option_by_uid"
            | "hover_element_by_uid"
            | "get_editor_value"
            | "scroll_to_element",
          capability: TOOL_CAPABILITIES.click,
          tabId,
          kindValue,
          action: {
            kind: kindValue,
            uid: uid || undefined,
            ref: ref || uid || undefined,
            selector: selector || undefined,
            backendNodeId: backendNodeId || undefined,
            value,
            expect: args.expect,
            forceFocus: args.forceFocus === true,
            requireFocus: args.requireFocus === true
          },
          expect: args.expect
        }
      };
    };

    const buildTabActionPlan = async (
      toolName: "press_key" | "scroll_page" | "navigate_tab",
      kindValue: "press" | "scroll" | "navigate"
    ): Promise<{ ok: true; plan: ToolPlan } | { ok: false; error: JsonRecord }> => {
      const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
      if (!tabId) {
        return {
          ok: false,
          error: attachFailureProtocol(toolName, {
            error: `${toolName} 需要 tabId，当前无可用 tab`,
            errorCode: "E_NO_TAB",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: `Call get_all_tabs and retry ${toolName} with a valid tabId.`
          }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
        };
      }

      const action: JsonRecord = {
        kind: kindValue,
        expect: args.expect,
        forceFocus: args.forceFocus === true,
        requireFocus: args.requireFocus === true
      };

      if (kindValue === "press") {
        const key = String(args.key || args.value || "").trim();
        if (!key) {
          return {
            ok: false,
            error: attachFailureProtocol(toolName, {
              error: "press_key 需要 key",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide key (e.g. Enter) and retry press_key."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        action.key = key;
        action.value = key;
      } else if (kindValue === "scroll") {
        const delta = Number(args.deltaY ?? args.value ?? args.y ?? 600);
        action.value = Number.isFinite(delta) ? delta : 600;
      } else if (kindValue === "navigate") {
        const url = String(args.url || "").trim();
        if (!url) {
          return {
            ok: false,
            error: attachFailureProtocol(toolName, {
              error: "navigate_tab 需要 url",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide url and retry navigate_tab."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        action.url = url;
      }

      return {
        ok: true,
        plan: {
          kind: "step.element_action",
          toolName,
          capability: TOOL_CAPABILITIES.click,
          tabId,
          kindValue,
          action,
          expect: args.expect
        }
      };
    };
    switch (context.executionTool) {
      case "bash": {
        const command = String(args.command || "").trim();
        if (!command) return { ok: false, error: { error: "bash 需要 command" } };
        const runtimeHint = normalizeRuntimeHint(args.runtime);
        const timeoutMs =
          args.timeoutMs == null
            ? undefined
            : normalizeIntInRange(args.timeoutMs, DEFAULT_BASH_TIMEOUT_MS, MIN_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
        return {
          ok: true,
          plan: {
            kind: "bridge",
            toolName: "bash",
            capability: TOOL_CAPABILITIES.bash,
            frame: {
              tool: "bash",
              args: {
                cmdId: "bash.exec",
                args: [command],
                ...(runtimeHint ? { runtime: runtimeHint } : {}),
                ...(timeoutMs == null ? {} : { timeoutMs })
              }
            }
          }
        };
      }
      case "read_file": {
        const path = String(args.path || "").trim();
        if (!path) return { ok: false, error: { error: "read_file 需要 path" } };
        const invokeArgs: JsonRecord = { path };
        const runtimeHint = normalizeRuntimeHint(args.runtime);
        if (args.offset != null) invokeArgs.offset = args.offset;
        if (args.limit != null) invokeArgs.limit = args.limit;
        if (runtimeHint) invokeArgs.runtime = runtimeHint;
        return {
          ok: true,
          plan: {
            kind: "bridge",
            toolName: "read_file",
            capability: TOOL_CAPABILITIES.read_file,
            frame: {
              tool: "read",
              args: invokeArgs
            }
          }
        };
      }
      case "write_file": {
        const path = String(args.path || "").trim();
        if (!path) return { ok: false, error: { error: "write_file 需要 path" } };
        const runtimeHint = normalizeRuntimeHint(args.runtime);
        return {
          ok: true,
          plan: {
            kind: "bridge",
            toolName: "write_file",
            capability: TOOL_CAPABILITIES.write_file,
            frame: {
              tool: "write",
              args: {
                path,
                content: String(args.content || ""),
                mode: String(args.mode || "overwrite"),
                ...(runtimeHint ? { runtime: runtimeHint } : {})
              }
            }
          }
        };
      }
      case "edit_file": {
        const path = String(args.path || "").trim();
        if (!path) return { ok: false, error: { error: "edit_file 需要 path" } };
        const runtimeHint = normalizeRuntimeHint(args.runtime);
        return {
          ok: true,
          plan: {
            kind: "bridge",
            toolName: "edit_file",
            capability: TOOL_CAPABILITIES.edit_file,
            frame: {
              tool: "edit",
              args: {
                path,
                edits: Array.isArray(args.edits) ? args.edits : [],
                ...(runtimeHint ? { runtime: runtimeHint } : {})
              }
            }
          }
        };
      }
      case "get_all_tabs":
        return { ok: true, plan: { kind: "local.get_all_tabs" } };
      case "get_current_tab":
        return { ok: true, plan: { kind: "local.current_tab" } };
      case "create_new_tab": {
        const rawUrl = String(args.url || "").trim();
        if (!rawUrl) return { ok: false, error: { error: "create_new_tab 需要 url" } };
        return {
          ok: true,
          plan: {
            kind: "local.create_new_tab",
            args: {
              url: rawUrl,
              active: args.active
            }
          }
        };
      }
      case "get_tab_info": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("get_tab_info", {
              error: "get_tab_info 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry get_tab_info with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.get_tab_info",
            tabId
          }
        };
      }
      case "close_tab": {
        const explicitTabId = parsePositiveInt(args.tabId);
        if (explicitTabId) {
          return {
            ok: true,
            plan: {
              kind: "local.close_tab",
              tabId: explicitTabId
            }
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.close_tab",
            tabId: null
          }
        };
      }
      case "ungroup_tabs": {
        const windowId = parsePositiveInt(args.windowId);
        return {
          ok: true,
          plan: {
            kind: "local.ungroup_tabs",
            windowId: windowId || null
          }
        };
      }
      case "search_elements": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("search_elements", {
              error: "search_elements 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry search_elements with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const maxResultsRaw = Number(args.maxResults);
        const maxResults = Number.isFinite(maxResultsRaw) ? Math.max(1, Math.min(120, Math.floor(maxResultsRaw))) : 20;
        return {
          ok: true,
          plan: {
            kind: "step.search_elements",
            capability: TOOL_CAPABILITIES.search_elements,
            tabId,
            query: String(args.query || "").trim(),
            maxResults,
            options: {
              mode: "interactive",
              selector: String(args.selector || ""),
              filter: "all",
              format: "json",
              diff: args.diff === true,
              maxTokens: args.maxTokens,
              depth: args.depth,
              noAnimations: args.noAnimations === true
            }
          }
        };
      }
      case "click":
        return await buildUidActionPlan("click", "click");
      case "fill_element_by_uid":
        return await buildUidActionPlan("fill_element_by_uid", "fill");
      case "select_option_by_uid":
        return await buildUidActionPlan("select_option_by_uid", "select", { requireValue: true });
      case "hover_element_by_uid":
        return await buildUidActionPlan("hover_element_by_uid", "hover");
      case "get_editor_value":
        return await buildUidActionPlan("get_editor_value", "read");
      case "press_key":
        return await buildTabActionPlan("press_key", "press");
      case "scroll_page":
        return await buildTabActionPlan("scroll_page", "scroll");
      case "navigate_tab":
        return await buildTabActionPlan("navigate_tab", "navigate");
      case "scroll_to_element":
        return await buildUidActionPlan("scroll_to_element", "hover");
      case "get_page_metadata": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("get_page_metadata", {
              error: "get_page_metadata 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry get_page_metadata with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const expression = `(() => {
          const getMeta = (name, property) => {
            const selector = property ? 'meta[property=\"' + property + '\"]' : 'meta[name=\"' + name + '\"]';
            const el = document.querySelector(selector);
            return el && typeof el.content === 'string' ? el.content : '';
          };
          return {
            title: document.title || '',
            url: location.href,
            description: getMeta('description', '') || getMeta('', 'og:description'),
            keywords: getMeta('keywords', ''),
            author: getMeta('author', '') || getMeta('', 'og:author'),
            ogImage: getMeta('', 'og:image'),
            favicon:
              (document.querySelector('link[rel=\"icon\"]') || document.querySelector('link[rel=\"shortcut icon\"]'))?.href || ''
          };
        })()`;
        return {
          ok: true,
          plan: {
            kind: "step.script_action",
            toolName: "get_page_metadata",
            capability: TOOL_CAPABILITIES.click,
            tabId,
            expression,
            expect: null
          }
        };
      }
      case "highlight_element": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("highlight_element", {
              error: "highlight_element 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry highlight_element with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const selector = String(args.selector || "").trim();
        if (!selector) {
          return {
            ok: false,
            error: attachFailureProtocol("highlight_element", {
              error: "highlight_element 需要 selector",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide selector and retry highlight_element."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const color = String(args.color || "#00d4ff");
        const durationMs = Number(args.durationMs ?? 1600);
        const normalizedDuration = Number.isFinite(durationMs) ? Math.max(0, Math.min(30_000, Math.floor(durationMs))) : 1600;
        const expression = `(() => {
          const selector = ${JSON.stringify(selector)};
          const color = ${JSON.stringify(color)};
          const duration = ${normalizedDuration};
          const nodes = Array.from(document.querySelectorAll(selector));
          if (!nodes.length) return { success: false, error: 'selector not found', selector };
          const marker = 'bbl-highlight-' + Date.now();
          for (const node of nodes) {
            const el = node;
            if (!(el instanceof HTMLElement)) continue;
            el.setAttribute('data-bbl-highlight', marker);
            el.style.outline = '2px solid ' + color;
            el.style.outlineOffset = '2px';
            el.style.boxShadow = '0 0 0 3px color-mix(in srgb, ' + color + ' 30%, transparent)';
          }
          if (duration > 0) {
            setTimeout(() => {
              for (const el of document.querySelectorAll('[data-bbl-highlight=\"' + marker + '\"]')) {
                if (!(el instanceof HTMLElement)) continue;
                el.style.outline = '';
                el.style.outlineOffset = '';
                el.style.boxShadow = '';
                el.removeAttribute('data-bbl-highlight');
              }
            }, duration);
          }
          return { success: true, count: nodes.length, selector, color, durationMs: duration, url: location.href, title: document.title };
        })()`;
        return {
          ok: true,
          plan: {
            kind: "step.script_action",
            toolName: "highlight_element",
            capability: TOOL_CAPABILITIES.click,
            tabId,
            expression,
            expect: normalizeVerifyExpect(args.expect || null)
          }
        };
      }
      case "highlight_text_inline": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("highlight_text_inline", {
              error: "highlight_text_inline 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry highlight_text_inline with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const selector = String(args.selector || "").trim();
        const searchText = String(args.searchText || "").trim();
        if (!selector || !searchText) {
          return {
            ok: false,
            error: attachFailureProtocol("highlight_text_inline", {
              error: "highlight_text_inline 需要 selector 和 searchText",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide selector + searchText and retry highlight_text_inline."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const caseSensitive = args.caseSensitive === true;
        const wholeWords = args.wholeWords === true;
        const highlightColor = String(args.highlightColor || "#DC143C");
        const backgroundColor = String(args.backgroundColor || "transparent");
        const fontWeight = String(args.fontWeight || "bold");
        const expression = `(() => {
          const selector = ${JSON.stringify(selector)};
          const searchText = ${JSON.stringify(searchText)};
          const caseSensitive = ${caseSensitive};
          const wholeWords = ${wholeWords};
          const highlightColor = ${JSON.stringify(highlightColor)};
          const backgroundColor = ${JSON.stringify(backgroundColor)};
          const fontWeight = ${JSON.stringify(fontWeight)};
          const nodes = Array.from(document.querySelectorAll(selector));
          if (!nodes.length) return { success: false, error: 'selector not found', selector };
          const escaped = searchText.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&');
          const source = wholeWords ? ('\\\\b' + escaped + '\\\\b') : escaped;
          const flags = caseSensitive ? 'g' : 'gi';
          const re = new RegExp(source, flags);
          let count = 0;
          for (const root of nodes) {
            if (!(root instanceof HTMLElement)) continue;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            while (walker.nextNode()) textNodes.push(walker.currentNode);
            for (const node of textNodes) {
              const text = node.textContent || '';
              if (!re.test(text)) continue;
              re.lastIndex = 0;
              const frag = document.createDocumentFragment();
              let last = 0;
              let hit;
              while ((hit = re.exec(text)) !== null) {
                if (hit.index > last) frag.appendChild(document.createTextNode(text.slice(last, hit.index)));
                const span = document.createElement('span');
                span.textContent = hit[0];
                span.style.color = highlightColor;
                span.style.backgroundColor = backgroundColor;
                span.style.fontWeight = fontWeight;
                span.setAttribute('data-bbl-inline-highlight', '1');
                frag.appendChild(span);
                count += 1;
                last = hit.index + hit[0].length;
              }
              if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
              node.parentNode?.replaceChild(frag, node);
            }
          }
          return { success: true, selector, searchText, matches: count, url: location.href, title: document.title };
        })()`;
        return {
          ok: true,
          plan: {
            kind: "step.script_action",
            toolName: "highlight_text_inline",
            capability: TOOL_CAPABILITIES.click,
            tabId,
            expression,
            expect: normalizeVerifyExpect(args.expect || null)
          }
        };
      }
      case "capture_screenshot":
      case "capture_tab_screenshot":
      case "capture_screenshot_with_highlight": {
        const requested = context.executionTool as "capture_screenshot" | "capture_tab_screenshot" | "capture_screenshot_with_highlight";
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(requested, {
              error: `${requested} 需要 tabId，当前无可用 tab`,
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: `Call get_all_tabs and retry ${requested} with a valid tabId.`
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const format = String(args.format || "png").trim().toLowerCase() === "jpeg" ? "jpeg" : "png";
        const qualityRaw = Number(args.quality);
        const quality = Number.isFinite(qualityRaw) ? Math.max(0, Math.min(100, Math.floor(qualityRaw))) : null;
        return {
          ok: true,
          plan: {
            kind: "step.capture_screenshot",
            toolName: requested,
            tabId,
            format,
            quality,
            selector: String(args.selector || "").trim(),
            sendToLLM: args.sendToLLM !== false
          }
        };
      }
      case "download_image": {
        const imageData = String(args.imageData || "").trim();
        if (!imageData.startsWith("data:image/")) {
          return {
            ok: false,
            error: attachFailureProtocol("download_image", {
              error: "download_image 需要 data:image/* 格式 imageData",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide a valid data:image URL and retry download_image."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("download_image", {
              error: "download_image 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry download_image with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const fallbackName = `image-${Date.now()}.png`;
        const filename = normalizeDownloadFilename(String(args.filename || ""), fallbackName);
        return {
          ok: true,
          plan: {
            kind: "step.download_image",
            tabId,
            imageData,
            filename
          }
        };
      }
      case "download_chat_images": {
        const rawMessages = Array.isArray(args.messages) ? (args.messages as unknown[]) : [];
        const strategy = String(args.filenamingStrategy || "descriptive").trim().toLowerCase();
        const files: Array<{ imageData: string; filename: string }> = [];
        let index = 0;
        for (const message of rawMessages) {
          const messageRecord = toRecord(message);
          const parts = Array.isArray(messageRecord.parts) ? (messageRecord.parts as unknown[]) : [];
          for (const part of parts) {
            const partRecord = toRecord(part);
            if (String(partRecord.type || "").trim().toLowerCase() !== "image") continue;
            const imageData = String(partRecord.imageData || "").trim();
            if (!imageData.startsWith("data:image/")) continue;
            index += 1;
            const imageTitle = String(partRecord.imageTitle || "").trim();
            const messageId = String(messageRecord.id || "").trim();
            const stem = strategy === "sequential"
              ? `image-${String(index).padStart(3, "0")}`
              : strategy === "timestamp"
                ? `image-${Date.now()}-${index}`
                : imageTitle || messageId || `image-${index}`;
            files.push({
              imageData,
              filename: normalizeDownloadFilename(stem, `image-${index}`)
            });
          }
        }
        if (!files.length) {
          return {
            ok: false,
            error: attachFailureProtocol("download_chat_images", {
              error: "download_chat_images 未找到可下载的 imageData",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide messages[].parts[].imageData with data:image URL."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("download_chat_images", {
              error: "download_chat_images 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry download_chat_images with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.download_chat_images",
            tabId,
            files
          }
        };
      }
      case "computer": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("computer", {
              error: "computer 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry computer with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const action = String(args.action || "").trim().toLowerCase();
        if (!action) {
          return {
            ok: false,
            error: attachFailureProtocol("computer", {
              error: "computer 需要 action",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide action and retry computer."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.computer",
            tabId,
            action,
            coordinate: toCoordinatePair(args.coordinate),
            startCoordinate: toCoordinatePair(args.start_coordinate),
            text: String(args.text || "").trim(),
            scrollDirection: String(args.scroll_direction || "").trim().toLowerCase(),
            scrollAmount: Number.isFinite(Number(args.scroll_amount)) ? Number(args.scroll_amount) : null,
            durationSec: Number.isFinite(Number(args.duration)) ? Number(args.duration) : null,
            uid: String(args.uid || "").trim(),
            selector: String(args.selector || "").trim()
          }
        };
      }
      case "list_interventions":
        return {
          ok: true,
          plan: {
            kind: "local.list_interventions",
            enabledOnly: args.enabledOnly === true
          }
        };
      case "get_intervention_info": {
        const type = normalizeInterventionType(args.type);
        if (!type) {
          return {
            ok: false,
            error: attachFailureProtocol("get_intervention_info", {
              error: "get_intervention_info 需要 type",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide intervention type and retry get_intervention_info."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.get_intervention_info",
            interventionType: type
          }
        };
      }
      case "request_intervention": {
        const type = normalizeInterventionType(args.type);
        if (!type) {
          return {
            ok: false,
            error: attachFailureProtocol("request_intervention", {
              error: "request_intervention 需要 type",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide intervention type and retry request_intervention."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        const timeoutSecRaw = Number(args.timeout ?? 300);
        const timeoutSec = Number.isFinite(timeoutSecRaw) ? Math.max(30, Math.min(3600, Math.floor(timeoutSecRaw))) : 300;
        return {
          ok: true,
          plan: {
            kind: "local.request_intervention",
            sessionId,
            interventionType: type,
            params: toRecord(args.params),
            timeoutSec,
            reason: String(args.reason || "").trim()
          }
        };
      }
      case "cancel_intervention":
        return {
          ok: true,
          plan: {
            kind: "local.cancel_intervention",
            sessionId,
            requestId: String(args.id || "").trim()
          }
        };
      case "list_skills":
        return {
          ok: true,
          plan: {
            kind: "local.list_skills",
            enabledOnly: args.enabledOnly === true
          }
        };
      case "get_skill_info": {
        const skillName = String(args.skillName || args.name || "").trim();
        if (!skillName) {
          return {
            ok: false,
            error: attachFailureProtocol("get_skill_info", {
              error: "get_skill_info 需要 skillName",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide skillName and retry get_skill_info."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.get_skill_info",
            skillName
          }
        };
      }
      case "load_skill": {
        const skillName = String(args.name || args.skillName || "").trim();
        if (!skillName) {
          return {
            ok: false,
            error: attachFailureProtocol("load_skill", {
              error: "load_skill 需要 name",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide skill name and retry load_skill."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.load_skill",
            sessionId,
            skillName
          }
        };
      }
      case "read_skill_reference": {
        const skillName = String(args.skillName || args.name || "").trim();
        const refPath = String(args.refPath || "").trim();
        if (!skillName || !refPath) {
          return {
            ok: false,
            error: attachFailureProtocol("read_skill_reference", {
              error: "read_skill_reference 需要 skillName 和 refPath",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide skillName + refPath and retry read_skill_reference."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.read_skill_reference",
            sessionId,
            skillName,
            refPath
          }
        };
      }
      case "get_skill_asset": {
        const skillName = String(args.skillName || args.name || "").trim();
        const assetPath = String(args.assetPath || "").trim();
        if (!skillName || !assetPath) {
          return {
            ok: false,
            error: attachFailureProtocol("get_skill_asset", {
              error: "get_skill_asset 需要 skillName 和 assetPath",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide skillName + assetPath and retry get_skill_asset."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.get_skill_asset",
            sessionId,
            skillName,
            assetPath
          }
        };
      }
      case "execute_skill_script": {
        const skillName = String(args.skillName || args.name || "").trim();
        const scriptPath = String(args.scriptPath || "").trim();
        if (!skillName || !scriptPath) {
          return {
            ok: false,
            error: attachFailureProtocol("execute_skill_script", {
              error: "execute_skill_script 需要 skillName 和 scriptPath",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide skillName + scriptPath and retry execute_skill_script."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.execute_skill_script",
            sessionId,
            skillName,
            scriptPath,
            scriptArgs: args.args
          }
        };
      }
      case "fill_form": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("fill_form", {
              error: "fill_form 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry fill_form with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const rawElements = Array.isArray(args.elements) ? (args.elements as unknown[]) : [];
        const elements = rawElements
          .map((item) => toRecord(item))
          .map((item) => ({
            uid: String(item.uid || "").trim(),
            ref: String(item.ref || "").trim(),
            selector: String(item.selector || "").trim(),
            backendNodeId: parsePositiveInt(item.backendNodeId),
            value: String(item.value || "")
          }))
          .filter((item) => item.value.length > 0);
        if (elements.length === 0) {
          return {
            ok: false,
            error: {
              error: "fill_form 需要 elements 且每项至少包含 value",
              errorCode: "E_ARGS"
            }
          };
        }
        if (elements.some((item) => !item.uid && !item.ref && !item.backendNodeId && !item.selector)) {
          return {
            ok: false,
            error: attachFailureProtocol("fill_form", {
              error: "fill_form 每个字段都需要 uid/ref/backendNodeId（或 selector 兜底）。请先调用 search_elements。",
              errorCode: "E_REF_REQUIRED",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call search_elements and map each field to uid/ref before fill_form."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.fill_form",
            capability: TOOL_CAPABILITIES.fill_form,
            tabId,
            elements,
            submit: Object.keys(toRecord(args.submit)).length > 0 ? toRecord(args.submit) : null,
            expect: normalizeVerifyExpect(args.expect || {}) || {}
          }
        };
      }
      case "browser_verify": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol("browser_verify", {
              error: "browser_verify 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs and retry browser_verify with a valid tabId."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        }
        const verifyExpect = normalizeVerifyExpect(args.expect || args) || {};
        if (Object.keys(verifyExpect).length === 0) {
          return {
            ok: false,
            error: attachFailureProtocol("browser_verify", {
              error: "browser_verify 需要明确 expect（如 url/title/text/selector/urlChanged）",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide explicit expect and retry browser_verify."
            }, { phase: "plan", category: "missing_target", resumeStrategy: "replan" })
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.browser_verify",
            capability: TOOL_CAPABILITIES.browser_verify,
            tabId,
            verifyExpect
          }
        };
      }
      default:
        return {
          ok: false,
          error: buildUnsupportedToolError({
            requestedTool: context.requestedTool,
            resolvedTool: context.resolvedTool,
            hasContract: true
          })
        };
    }
  }

  async function dispatchToolPlan(sessionId: string, plan: ToolPlan): Promise<JsonRecord> {
    switch (plan.kind) {
      case "bridge":
        return await invokeBridgeFrameWithRetry(sessionId, plan.toolName, plan.frame, plan.capability);
      case "local.get_all_tabs": {
        const tabs = await queryAllTabsForRuntime();
        const activeTabId = await getActiveTabIdForRuntime();
        return buildToolResponseEnvelope("tabs", {
          count: tabs.length,
          activeTabId,
          tabs
        });
      }
      case "local.current_tab": {
        const tabs = await queryAllTabsForRuntime();
        const activeTabId = await getActiveTabIdForRuntime();
        const tab = tabs.find((item) => Number(item.id) === Number(activeTabId)) || null;
        return buildToolResponseEnvelope("tabs", {
          activeTabId,
          tab
        });
      }
      case "local.create_new_tab": {
        const created = await chrome.tabs.create({
          url: String(plan.args.url || ""),
          active: plan.args.active !== false
        });
        return buildToolResponseEnvelope("tabs", {
          opened: true,
          tab: {
            id: created?.id || null,
            windowId: created?.windowId || null,
            active: created?.active === true,
            title: created?.title || "",
            url: created?.url || created?.pendingUrl || ""
          }
        });
      }
      case "local.get_tab_info": {
        const tab = await chrome.tabs.get(plan.tabId).catch(() => null);
        if (!tab?.id) {
          return attachFailureProtocol("get_tab_info", {
            error: `tab 不存在: ${plan.tabId}`,
            errorCode: "E_NO_TAB",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: "Call get_all_tabs and retry get_tab_info with a valid tabId."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" });
        }
        return buildToolResponseEnvelope("tab_info", {
          id: Number(tab.id),
          index: Number(tab.index || 0),
          windowId: Number(tab.windowId || 0),
          active: tab.active === true,
          pinned: tab.pinned === true,
          title: String(tab.title || ""),
          url: String(tab.url || tab.pendingUrl || "")
        });
      }
      case "local.close_tab": {
        let tabId = plan.tabId;
        if (!tabId) {
          tabId = await getActiveTabIdForRuntime();
        }
        if (!tabId) {
          return attachFailureProtocol("close_tab", {
            error: "close_tab 未找到可关闭 tab",
            errorCode: "E_NO_TAB",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: "Call get_all_tabs then retry close_tab with tabId."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" });
        }
        await chrome.tabs.remove(tabId).catch((error) => {
          throw createRuntimeError(`close_tab 失败: ${error instanceof Error ? error.message : String(error)}`, {
            code: "E_TOOL_EXECUTE",
            retryable: true
          });
        });
        return buildToolResponseEnvelope("close_tab", {
          success: true,
          tabId
        });
      }
      case "local.ungroup_tabs": {
        const tabs = await chrome.tabs.query(plan.windowId ? { windowId: plan.windowId } : { currentWindow: true });
        let ungroupedCount = 0;
        for (const tab of tabs) {
          if (!tab?.id) continue;
          if (typeof tab.groupId !== "number" || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) continue;
          await chrome.tabs.ungroup(tab.id).catch(() => undefined);
          ungroupedCount += 1;
        }
        return buildToolResponseEnvelope("ungroup_tabs", {
          success: true,
          windowId: plan.windowId || null,
          ungroupedCount
        });
      }
      case "local.list_interventions": {
        const interventions = Object.values(INTERVENTION_CATALOG).filter((item) => (plan.enabledOnly ? item.enabled : true));
        return buildToolResponseEnvelope("list_interventions", {
          success: true,
          count: interventions.length,
          interventions
        });
      }
      case "local.get_intervention_info": {
        const info = INTERVENTION_CATALOG[plan.interventionType];
        if (!info) {
          return attachFailureProtocol("get_intervention_info", {
            error: `未知 intervention type: ${plan.interventionType}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Use list_interventions and retry with valid type."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "replan" });
        }
        return buildToolResponseEnvelope("get_intervention_info", {
          success: true,
          intervention: info
        });
      }
      case "local.request_intervention": {
        const info = INTERVENTION_CATALOG[plan.interventionType];
        if (!info) {
          return attachFailureProtocol("request_intervention", {
            error: `未知 intervention type: ${plan.interventionType}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Use list_interventions and retry with valid type."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "replan" });
        }
        const requestId = `ivr_${crypto.randomUUID()}`;
        interventionRequests.set(requestId, {
          id: requestId,
          sessionId: plan.sessionId,
          type: plan.interventionType,
          params: plan.params,
          reason: plan.reason,
          timeoutSec: plan.timeoutSec,
          status: "pending",
          createdAt: nowIso()
        });
        const summary = [
          `[Intervention:${plan.interventionType}]`,
          plan.reason || "Need user intervention to continue.",
          Object.keys(plan.params || {}).length ? `params=${safeStringify(plan.params, 800)}` : ""
        ]
          .filter(Boolean)
          .join(" ");
        orchestrator.enqueueQueuedPrompt(plan.sessionId, "followUp", summary);
        return buildToolResponseEnvelope("request_intervention", {
          success: true,
          id: requestId,
          status: "pending",
          intervention: info,
          timeoutSec: plan.timeoutSec,
          message: "Intervention request queued as follow-up prompt."
        });
      }
      case "local.cancel_intervention": {
        const id = String(plan.requestId || "").trim();
        if (id) {
          const found = interventionRequests.get(id);
          if (!found) {
            return attachFailureProtocol("cancel_intervention", {
              error: `intervention 不存在: ${id}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Use request_intervention result id or omit id to cancel pending queue."
            }, { phase: "execute", category: "missing_target", resumeStrategy: "replan" });
          }
          found.status = "cancelled";
          interventionRequests.set(id, found);
        }
        orchestrator.clearQueuedPrompts(plan.sessionId);
        return buildToolResponseEnvelope("cancel_intervention", {
          success: true,
          id: id || null,
          cancelled: id ? 1 : "all_pending_queue"
        });
      }
      case "local.list_skills": {
        const skills = await orchestrator.listSkills();
        const filtered = plan.enabledOnly ? skills.filter((item) => item.enabled) : skills;
        return buildToolResponseEnvelope("list_skills", {
          success: true,
          count: filtered.length,
          skills: filtered
        });
      }
      case "local.get_skill_info": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol("get_skill_info", {
            error: `skill 不存在: ${plan.skillName}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Use list_skills then retry get_skill_info with valid skillName."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "replan" });
        }
        const base = String(skill.location || "").replace(/\/[^/]*$/, "");
        return buildToolResponseEnvelope("get_skill_info", {
          success: true,
          skill: {
            ...skill,
            paths: {
              scripts: `${base}/scripts/`,
              references: `${base}/references/`,
              assets: `${base}/assets/`
            }
          }
        });
      }
      case "local.load_skill": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol("load_skill", {
            error: `skill 不存在: ${plan.skillName}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Use list_skills then retry load_skill with valid name."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "replan" });
        }
        const content = await readTextByLocation(plan.sessionId, skill.location);
        return buildToolResponseEnvelope("load_skill", {
          success: true,
          skill,
          content
        });
      }
      case "local.read_skill_reference": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol("read_skill_reference", {
            error: `skill 不存在: ${plan.skillName}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Use list_skills then retry read_skill_reference with valid skillName."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "replan" });
        }
        const normalizedRef = plan.refPath.startsWith("references/") ? plan.refPath : `references/${plan.refPath}`;
        const location = buildSkillChildLocation(skill.location, normalizedRef);
        const content = await readTextByLocation(plan.sessionId, location);
        return buildToolResponseEnvelope("read_skill_reference", {
          success: true,
          skill: {
            id: skill.id,
            name: skill.name
          },
          refPath: normalizedRef,
          location,
          content
        });
      }
      case "local.get_skill_asset": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol("get_skill_asset", {
            error: `skill 不存在: ${plan.skillName}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Use list_skills then retry get_skill_asset with valid skillName."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "replan" });
        }
        const normalizedAsset = plan.assetPath.startsWith("assets/") ? plan.assetPath : `assets/${plan.assetPath}`;
        const location = buildSkillChildLocation(skill.location, normalizedAsset);
        const content = await readTextByLocation(plan.sessionId, location);
        return buildToolResponseEnvelope("get_skill_asset", {
          success: true,
          skill: {
            id: skill.id,
            name: skill.name
          },
          assetPath: normalizedAsset,
          location,
          content
        });
      }
      case "local.execute_skill_script": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol("execute_skill_script", {
            error: `skill 不存在: ${plan.skillName}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Use list_skills then retry execute_skill_script with valid skillName."
          }, { phase: "execute", category: "missing_target", resumeStrategy: "replan" });
        }
        const normalizedScript = plan.scriptPath.startsWith("scripts/") ? plan.scriptPath : `scripts/${plan.scriptPath}`;
        const location = buildSkillChildLocation(skill.location, normalizedScript);
        if (isVirtualUri(location)) {
          const source = await readTextByLocation(plan.sessionId, location);
          return attachFailureProtocol("execute_skill_script", {
            error: "当前脚本位于虚拟文件系统，无法直接在本地 shell 执行",
            errorCode: "E_TOOL_UNSUPPORTED",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Move script to local path or execute equivalent steps via bash/read_file.",
            details: {
              location,
              sourcePreview: clipText(source, 1200)
            }
          }, {
            phase: "execute",
            category: "missing_target",
            resumeStrategy: "replan"
          });
        }

        const argPayload =
          plan.scriptArgs === undefined
            ? "{}"
            : safeStringify(plan.scriptArgs, 8_000);
        const ext = location.split(".").pop()?.toLowerCase() || "";
        const command = (() => {
          if (ext === "js" || ext === "mjs" || ext === "cjs") {
            return `node ${shellQuote(location)} ${shellQuote(argPayload)}`;
          }
          if (ext === "ts" || ext === "tsx") {
            return `bun ${shellQuote(location)} ${shellQuote(argPayload)}`;
          }
          if (ext === "sh") {
            return `bash ${shellQuote(location)} ${shellQuote(argPayload)}`;
          }
          return `bash ${shellQuote(location)} ${shellQuote(argPayload)}`;
        })();

        const out = await executeStep({
          sessionId: plan.sessionId,
          capability: TOOL_CAPABILITIES.bash,
          action: "invoke",
          args: {
            frame: {
              tool: "bash",
              args: {
                cmdId: "bash.exec",
                args: [command],
                runtime: "local"
              }
            }
          },
          verifyPolicy: "off"
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            "execute_skill_script",
            out,
            "execute_skill_script 执行失败",
            "Check script path/runtime and retry execute_skill_script.",
            {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "replan"
            }
          );
        }
        return buildToolResponseEnvelope("execute_skill_script", {
          success: true,
          executed: true,
          skill: {
            id: skill.id,
            name: skill.name
          },
          scriptPath: normalizedScript,
          location,
          command,
          result: out.data
        });
      }
      case "step.search_elements": {
        const out = await executeStep({
          sessionId,
          capability: plan.capability,
          action: "snapshot",
          args: {
            tabId: plan.tabId,
            options: plan.options
          }
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            "search_elements",
            out,
            "search_elements 执行失败",
            "Take a fresh snapshot and retry search_elements with a valid scope.",
            {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot"
            }
          );
        }
        const snapshotData = toRecord(out.data);
        const rawNodes = Array.isArray(snapshotData.nodes) ? (snapshotData.nodes as JsonRecord[]) : [];
        const query = String(plan.query || "").trim().toLowerCase();
        const needles = query.split(/\s+/).map((item) => item.trim()).filter(Boolean);
        const normalizedNodes = rawNodes.map((node) => {
          const ref = String(node.ref || "");
          return {
            ...node,
            uid: String(node.uid || ref),
            ref
          };
        });
        const rankedNodes = normalizedNodes.map((node, index) => {
          const ranked = scoreSearchNode(node, needles);
          return {
            node,
            index,
            score: ranked.score,
            matchedNeedles: ranked.matchedNeedles
          };
        });
        const filteredRanked = needles.length
          ? rankedNodes.filter((item) => item.matchedNeedles > 0)
          : rankedNodes;
        const sortedRanked = needles.length
          ? filteredRanked.sort((a, b) => {
              const aFullMatch = a.matchedNeedles >= needles.length;
              const bFullMatch = b.matchedNeedles >= needles.length;
              if (aFullMatch !== bFullMatch) return bFullMatch ? 1 : -1;
              if (a.score !== b.score) return b.score - a.score;
              return a.index - b.index;
            })
          : filteredRanked;
        const nodes = sortedRanked.slice(0, plan.maxResults).map((item) => item.node);
        return buildToolResponseEnvelope("search_elements", {
          query: plan.query,
          tabId: plan.tabId,
          count: nodes.length,
          total: sortedRanked.length,
          nodes,
          snapshotId: String(snapshotData.snapshotId || ""),
          url: String(snapshotData.url || ""),
          title: String(snapshotData.title || "")
        }, {
          capabilityUsed: out.capabilityUsed || plan.capability,
          modeUsed: out.modeUsed
        });
      }
      case "step.element_action": {
        const out = await executeStep({
          sessionId,
          capability: plan.capability,
          action: "action",
          args: {
            tabId: plan.tabId,
            action: plan.action,
            expect: plan.expect
          }
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            plan.toolName,
            out,
            `${plan.toolName} 执行失败`,
            "Take a fresh snapshot and retry with updated ref/selector.",
            {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot"
            }
          );
        }
        const providerAction = toRecord(out.data);
        const verified = typeof providerAction.verified === "boolean" ? providerAction.verified : out.verified;
        const verifyReason = String(providerAction.verifyReason || out.verifyReason || "");
        const actionData = providerAction.data !== undefined ? providerAction.data : out.data;
        const explicitExpect = normalizeVerifyExpect(plan.expect || null);
        const hardFail = !!explicitExpect;
        if (!verified && hardFail) {
          const errorReason = mapVerifyReasonToFailureReason(verifyReason);
          return attachFailureProtocol(plan.toolName, {
            error: `${plan.toolName} 执行成功但未通过验证`,
            errorCode: "E_VERIFY_FAILED",
            errorReason,
            retryable: true,
            retryHint: "Adjust action args/expect and retry the browser action.",
            details: {
              verifyReason,
              data: actionData
            }
          }, {
            phase: "verify",
            resumeStrategy: "retry_with_fresh_snapshot"
          });
        }
        return buildToolResponseEnvelope(plan.toolName, actionData, {
          capabilityUsed: out.capabilityUsed || plan.capability,
          modeUsed: out.modeUsed,
          verifyReason,
          verified
        });
      }
      case "step.script_action": {
        const out = await callInfra(infra, {
          type: "cdp.execute",
          tabId: plan.tabId,
          action: {
            type: "runtime.evaluate",
            expression: plan.expression,
            returnByValue: true
          }
        }).catch((error) => {
          const runtimeError = asRuntimeErrorWithMeta(error);
          return {
            error: attachFailureProtocol(plan.toolName, {
              error: runtimeError.message,
              errorCode: normalizeErrorCode(runtimeError.code) || "E_TOOL_EXECUTE",
              errorReason: "failed_execute",
              retryable: runtimeError.retryable === true,
              retryHint: "Re-observe page state and retry with updated selector/target.",
              details: runtimeError.details
            }, { phase: "execute", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        });
        if (toRecord(out).error) return toRecord(out).error as JsonRecord;
        const resultValue = toRecord(toRecord(out).result).value ?? toRecord(out).result ?? out;
        const expect = normalizeVerifyExpect(plan.expect || null);
        if (expect) {
          const verifyOut = await executeStep({
            sessionId,
            capability: TOOL_CAPABILITIES.browser_verify,
            action: "verify",
            args: {
              tabId: plan.tabId,
              action: {
                expect
              },
              result: resultValue
            },
            verifyPolicy: "off"
          });
          if (!verifyOut.ok || verifyOut.verified !== true) {
            return attachFailureProtocol(plan.toolName, {
              error: `${plan.toolName} 后置验证失败`,
              errorCode: normalizeErrorCode(verifyOut.errorCode) || "E_VERIFY_FAILED",
              errorReason: mapVerifyReasonToFailureReason(verifyOut.verifyReason),
              retryable: true,
              retryHint: "Refine selector/expect and retry.",
              details: verifyOut.data || verifyOut.errorDetails || null
            }, { phase: "verify", resumeStrategy: "retry_with_fresh_snapshot" });
          }
        }
        return buildToolResponseEnvelope(plan.toolName, resultValue, {
          capabilityUsed: plan.capability,
          modeUsed: "cdp"
        });
      }
      case "step.capture_screenshot": {
        if (plan.toolName === "capture_screenshot_with_highlight" && plan.selector) {
          const highlightExpression = `(() => {
            const selector = ${JSON.stringify(plan.selector)};
            const nodes = Array.from(document.querySelectorAll(selector));
            if (!nodes.length) return { ok: false, selector };
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              node.setAttribute('data-bbl-capture-highlight', '1');
              node.style.outline = '2px solid #ff6a00';
              node.style.outlineOffset = '2px';
            }
            return { ok: true, count: nodes.length, selector };
          })()`;
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              type: "runtime.evaluate",
              expression: highlightExpression,
              returnByValue: true
            }
          }).catch(() => undefined);
        }

        const screenshot = await callInfra(infra, {
          type: "cdp.execute",
          tabId: plan.tabId,
          action: {
            domain: "Page",
            method: "captureScreenshot",
            params: {
              format: plan.format,
              ...(plan.quality == null ? {} : { quality: plan.quality })
            }
          }
        }).catch((error) => {
          const runtimeError = asRuntimeErrorWithMeta(error);
          return {
            error: attachFailureProtocol(plan.toolName, {
              error: runtimeError.message,
              errorCode: normalizeErrorCode(runtimeError.code) || "E_TOOL_EXECUTE",
              errorReason: "failed_execute",
              retryable: runtimeError.retryable === true,
              retryHint: "Re-check tab focus/state and retry screenshot.",
              details: runtimeError.details
            }, { phase: "execute", resumeStrategy: "retry_with_fresh_snapshot" })
          };
        });

        if (toRecord(screenshot).error) return toRecord(screenshot).error as JsonRecord;
        const base64 = String(toRecord(screenshot).data || "");
        if (!base64) {
          return attachFailureProtocol(plan.toolName, {
            error: "截图结果为空",
            errorCode: "E_TOOL_EXECUTE",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: "Retry capture_screenshot after page settles."
          }, { phase: "execute", resumeStrategy: "retry_with_fresh_snapshot" });
        }

        if (plan.toolName === "capture_screenshot_with_highlight" && plan.selector) {
          const cleanupExpression = `(() => {
            for (const node of document.querySelectorAll('[data-bbl-capture-highlight=\"1\"]')) {
              if (!(node instanceof HTMLElement)) continue;
              node.style.outline = '';
              node.style.outlineOffset = '';
              node.removeAttribute('data-bbl-capture-highlight');
            }
            return { ok: true };
          })()`;
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              type: "runtime.evaluate",
              expression: cleanupExpression,
              returnByValue: true
            }
          }).catch(() => undefined);
        }

        const tabInfo = await chrome.tabs.get(plan.tabId).catch(() => null);
        const imageData = `data:image/${plan.format};base64,${base64}`;
        return buildToolResponseEnvelope(plan.toolName, {
          success: true,
          tabId: plan.tabId,
          imageData,
          sendToLLM: plan.sendToLLM,
          selector: plan.selector || undefined,
          url: String(tabInfo?.url || tabInfo?.pendingUrl || ""),
          title: String(tabInfo?.title || "")
        });
      }
      case "step.download_image": {
        const expression = `(() => {
          const dataUrl = ${JSON.stringify(plan.imageData)};
          const filename = ${JSON.stringify(plan.filename)};
          if (!dataUrl || !String(dataUrl).startsWith('data:image/')) {
            return { success: false, error: 'invalid_image_data' };
          }
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = filename;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return { success: true, filename, url: location.href, title: document.title };
        })()`;
        const out = await callInfra(infra, {
          type: "cdp.execute",
          tabId: plan.tabId,
          action: {
            type: "runtime.evaluate",
            expression,
            returnByValue: true
          }
        });
        return buildToolResponseEnvelope("download_image", toRecord(toRecord(out).result).value || out);
      }
      case "step.download_chat_images": {
        const results: Array<JsonRecord> = [];
        for (let i = 0; i < plan.files.length; i += 1) {
          const file = plan.files[i];
          const expression = `(() => {
            const dataUrl = ${JSON.stringify(file.imageData)};
            const filename = ${JSON.stringify(file.filename)};
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = filename;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return { success: true, filename };
          })()`;
          const out = await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              type: "runtime.evaluate",
              expression,
              returnByValue: true
            }
          });
          results.push(toRecord(toRecord(out).result).value || {});
          await delay(60);
        }
        return buildToolResponseEnvelope("download_chat_images", {
          success: true,
          downloaded: results.length,
          results
        });
      }
      case "step.computer": {
        const action = plan.action;
        if (action === "wait") {
          const waitMs = Math.max(0, Math.min(60_000, Math.floor((plan.durationSec ?? 1) * 1000)));
          await delay(waitMs);
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            waitedMs: waitMs
          });
        }
        if (action === "type") {
          const text = String(plan.text || "");
          const expression = `(() => {
            const text = ${JSON.stringify(text)};
            const target = document.activeElement || document.body;
            if (!target) return { success: false, error: 'no_active_element' };
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              target.value = text;
              target.dispatchEvent(new Event('input', { bubbles: true }));
              target.dispatchEvent(new Event('change', { bubbles: true }));
              return { success: true, action: 'type', typed: text.length };
            }
            if (target.isContentEditable) {
              let usedInsertText = false;
              try {
                if (typeof document.execCommand === 'function') {
                  try { document.execCommand('selectAll', false); } catch {}
                  usedInsertText = document.execCommand('insertText', false, text) === true;
                }
              } catch {
                usedInsertText = false;
              }
              if (!usedInsertText) target.textContent = text;
              target.dispatchEvent(new Event('input', { bubbles: true }));
              return { success: true, action: 'type', typed: text.length, via: usedInsertText ? 'execCommand' : 'textContent' };
            }
            return { success: false, error: 'active_element_not_typable' };
          })()`;
          const out = await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              type: "runtime.evaluate",
              expression,
              returnByValue: true
            }
          });
          const result = toRecord(toRecord(out).result).value || out;
          const payload = toRecord(result);
          const success = payload.success === true || payload.ok === true;
          if (!success) {
            return attachFailureProtocol("computer", {
              error: String(payload.error || "computer(type) 执行失败"),
              errorCode: "E_TOOL_EXECUTE",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Focus an editable target (input/textarea/contenteditable) and retry computer(type).",
              details: payload
            }, { phase: "execute", category: "missing_target", resumeStrategy: "retry_with_fresh_snapshot" });
          }
          return buildToolResponseEnvelope("computer", result);
        }
        if (action === "key") {
          const keys = String(plan.text || "")
            .split(/\\s+/)
            .map((item) => item.trim())
            .filter(Boolean);
          if (!keys.length) {
            return attachFailureProtocol("computer", {
              error: "computer(key) 需要 text",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide text key sequence and retry computer."
            }, { phase: "execute", resumeStrategy: "replan" });
          }
          for (const key of keys) {
            await executeStep({
              sessionId,
              capability: TOOL_CAPABILITIES.click,
              action: "action",
              args: {
                tabId: plan.tabId,
                action: {
                  kind: "press",
                  key
                }
              },
              verifyPolicy: "off"
            });
          }
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            keys
          });
        }
        if (action === "scroll_to") {
          const target = plan.uid || plan.selector;
          if (!target) {
            return attachFailureProtocol("computer", {
              error: "computer(scroll_to) 需要 uid 或 selector",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide uid/selector and retry computer scroll_to."
            }, { phase: "execute", resumeStrategy: "replan" });
          }
          const out = await executeStep({
            sessionId,
            capability: TOOL_CAPABILITIES.click,
            action: "action",
            args: {
              tabId: plan.tabId,
              action: {
                kind: "hover",
                uid: plan.uid || undefined,
                ref: plan.uid || undefined,
                selector: plan.selector || undefined
              }
            },
            verifyPolicy: "off"
          });
          if (!out.ok) {
            return buildStepFailureEnvelope("computer", out, "computer scroll_to 失败", "Refresh target and retry computer scroll_to.", {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot"
            });
          }
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            target
          });
        }
        const coordinate = plan.coordinate;
        const startCoordinate = plan.startCoordinate;
        if (!coordinate && action !== "scroll") {
          return attachFailureProtocol("computer", {
            error: `computer(${action}) 需要 coordinate`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Provide coordinate and retry computer."
          }, { phase: "execute", resumeStrategy: "replan" });
        }
        const [x, y] = coordinate || [0, 0];
        const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        const button = action === "right_click" ? "right" : "left";
        const dispatchMouse = async (type: string, params: JsonRecord = {}) =>
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              domain: "Input",
              method: "dispatchMouseEvent",
              params: {
                type,
                x,
                y,
                button,
                clickCount,
                ...params
              }
            }
          });
        if (action === "hover" || action === "left_click" || action === "right_click" || action === "double_click" || action === "triple_click") {
          await dispatchMouse("mouseMoved");
          if (action !== "hover") {
            await dispatchMouse("mousePressed");
            await dispatchMouse("mouseReleased");
          }
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            coordinate: [x, y]
          });
        }
        if (action === "left_click_drag") {
          if (!startCoordinate || !coordinate) {
            return attachFailureProtocol("computer", {
              error: "computer(left_click_drag) 需要 start_coordinate 和 coordinate",
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide both start_coordinate and coordinate."
            }, { phase: "execute", resumeStrategy: "replan" });
          }
          const [sx, sy] = startCoordinate;
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              domain: "Input",
              method: "dispatchMouseEvent",
              params: { type: "mouseMoved", x: sx, y: sy, button: "left" }
            }
          });
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              domain: "Input",
              method: "dispatchMouseEvent",
              params: { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1 }
            }
          });
          await dispatchMouse("mouseMoved", { buttons: 1 });
          await dispatchMouse("mouseReleased", { clickCount: 1 });
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            start_coordinate: [sx, sy],
            coordinate: [x, y]
          });
        }
        if (action === "scroll") {
          const amount = Number.isFinite(Number(plan.scrollAmount)) ? Number(plan.scrollAmount) : 1000;
          const direction = plan.scrollDirection || "down";
          const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
          const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              domain: "Input",
              method: "dispatchMouseEvent",
              params: {
                type: "mouseWheel",
                x: x || 0,
                y: y || 0,
                deltaX,
                deltaY
              }
            }
          });
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            deltaX,
            deltaY
          });
        }
        return attachFailureProtocol("computer", {
          error: `computer 不支持 action: ${action}`,
          errorCode: "E_ARGS",
          errorReason: "failed_execute",
          retryable: false,
          retryHint: "Use supported computer action and retry."
        }, { phase: "execute", resumeStrategy: "replan" });
      }
      case "step.fill_form": {
        const itemResults: JsonRecord[] = [];
        for (let i = 0; i < plan.elements.length; i += 1) {
          const item = plan.elements[i];
          const out = await executeStep({
            sessionId,
            capability: plan.capability,
            action: "action",
            args: {
              tabId: plan.tabId,
              action: {
                kind: "fill",
                uid: item.uid || undefined,
                ref: item.ref || item.uid || undefined,
                selector: item.selector || undefined,
                backendNodeId: item.backendNodeId || undefined,
                value: item.value
              }
            }
          });
          if (!out.ok) {
            return attachFailureProtocol("fill_form", {
              error: `fill_form 第 ${i + 1} 项填写失败`,
              errorCode: normalizeErrorCode(out.errorCode) || undefined,
              errorReason: "failed_execute",
              retryable: out.retryable === true,
              retryHint: "Refresh elements with search_elements and retry fill_form.",
              details: {
                index: i,
                item,
                error: out.error || "",
                errorCode: out.errorCode || "",
                errorDetails: out.errorDetails || null
              }
            }, {
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot"
            });
          }
          const payload = toRecord(out.data);
          itemResults.push({
            index: i,
            uid: item.uid || item.ref || "",
            ok: true,
            result: payload.data !== undefined ? payload.data : out.data
          });
        }

        if (plan.submit && Object.keys(plan.submit).length > 0) {
          const submitKind = String(plan.submit.kind || "").trim().toLowerCase() || "click";
          const submitOut = await executeStep({
            sessionId,
            capability: plan.capability,
            action: "action",
            args: {
              tabId: plan.tabId,
              action: {
                kind: submitKind,
                uid: String(plan.submit.uid || "").trim() || undefined,
                ref: String(plan.submit.ref || "").trim() || undefined,
                selector: String(plan.submit.selector || "").trim() || undefined,
                key: String(plan.submit.key || "").trim() || undefined
              }
            }
          });
          if (!submitOut.ok) {
            return attachFailureProtocol("fill_form", {
              error: "fill_form 提交动作失败",
              errorCode: normalizeErrorCode(submitOut.errorCode) || undefined,
              errorReason: "failed_execute",
              retryable: submitOut.retryable === true,
              retryHint: "Retry submit action after refreshing element refs.",
              details: {
                submit: plan.submit,
                error: submitOut.error || "",
                errorCode: submitOut.errorCode || ""
              }
            }, {
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot"
            });
          }
          itemResults.push({
            index: itemResults.length,
            submit: true,
            ok: true,
            result: submitOut.data
          });
        }

        if (Object.keys(plan.expect || {}).length > 0) {
          const verifyOut = await executeStep({
            sessionId,
            capability: TOOL_CAPABILITIES.browser_verify,
            action: "verify",
            args: {
              tabId: plan.tabId,
              action: {
                expect: plan.expect
              }
            },
            verifyPolicy: "off"
          });
          if (!verifyOut.ok || verifyOut.verified !== true) {
            return attachFailureProtocol("fill_form", {
              error: "fill_form 后置验证失败",
              errorCode: normalizeErrorCode(verifyOut.errorCode) || "E_VERIFY_FAILED",
              errorReason: mapVerifyReasonToFailureReason(verifyOut.verifyReason),
              retryable: true,
              retryHint: "Refresh page state and retry fill_form with updated refs.",
              details: {
                expect: plan.expect,
                verifyReason: verifyOut.verifyReason || "",
                verifyError: verifyOut.error || ""
              }
            }, {
              phase: "verify",
              resumeStrategy: "retry_with_fresh_snapshot"
            });
          }
        }

        return buildToolResponseEnvelope("fill_form", {
          tabId: plan.tabId,
          filled: plan.elements.length,
          results: itemResults
        }, {
          capabilityUsed: plan.capability,
          modeUsed: "cdp"
        });
      }
      case "step.browser_verify": {
        const out = await executeStep({
          sessionId,
          capability: plan.capability,
          action: "verify",
          args: {
            tabId: plan.tabId,
            action: {
              expect: plan.verifyExpect
            }
          },
          verifyPolicy: "off"
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            "browser_verify",
            out,
            "browser_verify 执行失败",
            "Update verify expectation and run browser_verify again.",
            {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot"
            }
          );
        }
        const providerVerify = toRecord(out.data);
        const verified = typeof providerVerify.verified === "boolean" ? providerVerify.verified : out.verified;
        const verifyData = providerVerify.data !== undefined ? providerVerify.data : out.data;
        if (!verified) {
          return attachFailureProtocol("browser_verify", {
            error: "browser_verify 未通过",
            errorCode: "E_VERIFY_FAILED",
            errorReason: mapVerifyReasonToFailureReason(out.verifyReason),
            retryable: true,
            retryHint: "Refine expect conditions and re-run browser_verify.",
            details: verifyData
          }, {
            phase: "verify",
            resumeStrategy: "replan"
          });
        }
        return buildToolResponseEnvelope("cdp", verifyData, {
          capabilityUsed: out.capabilityUsed || plan.capability,
          modeUsed: out.modeUsed
        });
      }
      default:
        return { error: "未知工具执行计划", errorCode: "E_TOOL_PLAN" };
    }
  }

  function getToolPlanTabId(plan: ToolPlan): number | null {
    if (
      plan.kind === "step.search_elements" ||
      plan.kind === "step.element_action" ||
      plan.kind === "step.script_action" ||
      plan.kind === "step.capture_screenshot" ||
      plan.kind === "step.download_image" ||
      plan.kind === "step.download_chat_images" ||
      plan.kind === "step.computer" ||
      plan.kind === "step.fill_form" ||
      plan.kind === "step.browser_verify"
    ) {
      return Number.isInteger(plan.tabId) ? Number(plan.tabId) : null;
    }
    return null;
  }

  function mergeStepRef(result: JsonRecord, stepRef: JsonRecord): JsonRecord {
    const existing = toRecord(result.stepRef);
    if (Object.keys(existing).length > 0) {
      return {
        ...result,
        stepRef: {
          ...stepRef,
          ...existing
        }
      };
    }
    return {
      ...result,
      stepRef
    };
  }

  async function executeToolCall(sessionId: string, toolCall: ToolCallItem): Promise<JsonRecord> {
    const requestedTool = String(toolCall.function.name || "").trim();
    const baseStepRef: JsonRecord = {
      toolCallId: String(toolCall.id || ""),
      requestedTool: requestedTool || "unknown",
      argsSignature: normalizeToolArgsForSignature(toolCall.function.arguments || "")
    };

    const resolved = resolveToolCallContext(toolCall);
    if (!resolved.ok) {
      return mergeStepRef(resolved.error, {
        ...baseStepRef,
        stage: "resolve"
      });
    }

    const resolvedStepRef: JsonRecord = {
      ...baseStepRef,
      resolvedTool: resolved.value.resolvedTool,
      executionTool: resolved.value.executionTool
    };

    const planResult = await buildToolPlan(sessionId, resolved.value);
    if (!planResult.ok) {
      return mergeStepRef(planResult.error, {
        ...resolvedStepRef,
        stage: "plan"
      });
    }

    const tabId = getToolPlanTabId(planResult.plan);
    const planStepRef: JsonRecord = {
      ...resolvedStepRef,
      stage: "dispatch",
      planKind: planResult.plan.kind
    };
    if (tabId) planStepRef.tabId = tabId;

    const dispatched = await dispatchToolPlan(sessionId, planResult.plan);
    return mergeStepRef(dispatched, planStepRef);
  }

  async function requestLlmWithRetry(input: LlmRequestInput): Promise<JsonRecord> {
    const { sessionId, route, providerRegistry, step, messages } = input;
    const toolChoice = input.toolChoice === "required" ? "required" : "auto";
    const toolScope = input.toolScope === "browser_only" ? "browser_only" : "all";
    const llmModel = String(route.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex";
    const llmTimeoutMs = normalizeIntInRange(route.llmTimeoutMs, DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS);
    const llmMaxRetryDelayMs = normalizeIntInRange(
      route.llmMaxRetryDelayMs,
      DEFAULT_LLM_MAX_RETRY_DELAY_MS,
      MIN_LLM_MAX_RETRY_DELAY_MS,
      MAX_LLM_MAX_RETRY_DELAY_MS
    );
    const provider = providerRegistry.get(String(route.provider || "").trim());
    if (!provider) {
      throw createNonRetryableRuntimeError("E_LLM_PROVIDER_NOT_FOUND", `未找到 LLM provider: ${route.provider}`, {
        provider: route.provider,
        profile: route.profile
      });
    }
    let lastError: unknown = null;
    const configuredMaxAttempts = Number(orchestrator.getRunState(sessionId).retry.maxAttempts ?? MAX_LLM_RETRIES);
    const maxAttempts = Number.isFinite(configuredMaxAttempts)
      ? Math.max(0, configuredMaxAttempts)
      : MAX_LLM_RETRIES;
    const totalAttempts = maxAttempts + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort("llm-timeout"), llmTimeoutMs);
      let status = 0;
      let ok = false;
      let rawBody = "";
      let contentType = "";
      try {
        const browserOnlyTools = new Set(CANONICAL_BROWSER_TOOL_NAMES);
        const llmToolDefs = orchestrator
          .listLlmToolDefinitions()
          .filter((definition) => {
            const toolName = String(definition.function?.name || "").trim();
            if (!toolName) return false;
            const contract = orchestrator.resolveToolContract(toolName);
            const canonical = String(contract?.name || toolName).trim();
            return RUNTIME_EXECUTABLE_TOOL_NAMES.has(canonical);
          })
          .filter((definition) => {
            if (toolScope !== "browser_only") return true;
            const toolName = String(definition.function?.name || "").trim();
            const contract = orchestrator.resolveToolContract(toolName);
            const canonical = String(contract?.name || toolName).trim();
            return browserOnlyTools.has(canonical);
          })
          .map((definition) => sanitizeLlmToolDefinitionForProvider(definition, route.provider));
        const basePayload: JsonRecord = {
          model: llmModel,
          messages,
          tools: llmToolDefs,
          tool_choice: toolChoice,
          temperature: 0.2,
          stream: true
        };
        const baseUrl = provider.resolveRequestUrl(route);
        const beforeRequest = await orchestrator.runHook("llm.before_request", {
          request: {
            sessionId,
            step,
            attempt,
            profile: route.profile,
            provider: route.provider,
            url: baseUrl,
            payload: basePayload
          }
        });
        if (beforeRequest.blocked) {
          throw createNonRetryableRuntimeError("E_LLM_HOOK_BLOCKED", `llm.before_request blocked: ${beforeRequest.reason || "blocked"}`);
        }
        const patchedRequest = toRecord(beforeRequest.value.request);
        const requestUrlRaw = patchedRequest.url;
        if (requestUrlRaw !== undefined && typeof requestUrlRaw !== "string") {
          throw createNonRetryableRuntimeError("E_LLM_HOOK_INVALID_PATCH", "llm.before_request patch request.url must be a string");
        }
        const requestPayloadRaw = patchedRequest.payload;
        if (requestPayloadRaw !== undefined && !isPlainJsonRecord(requestPayloadRaw)) {
          throw createNonRetryableRuntimeError("E_LLM_HOOK_INVALID_PATCH", "llm.before_request patch request.payload must be an object");
        }
        const requestUrl = String(requestUrlRaw || baseUrl).trim() || baseUrl;
        const requestPayload: JsonRecord = {
          ...basePayload,
          ...(requestPayloadRaw || {})
        };
        if (!Array.isArray(requestPayload.messages)) requestPayload.messages = messages;
        if (!Array.isArray(requestPayload.tools)) requestPayload.tools = llmToolDefs;
        if (!String(requestPayload.model || "").trim()) requestPayload.model = llmModel;
        if (!requestPayload.tool_choice) requestPayload.tool_choice = toolChoice;
        if (typeof requestPayload.temperature !== "number" || !Number.isFinite(requestPayload.temperature)) {
          requestPayload.temperature = 0.2;
        }
        if (typeof requestPayload.stream !== "boolean") requestPayload.stream = true;
        requestPayload.messages = transformMessagesForLlm(
          Array.isArray(requestPayload.messages) ? requestPayload.messages : []
        );

        orchestrator.events.emit("llm.request", sessionId, {
          step,
          url: requestUrl,
          model: String(requestPayload.model || llmModel),
          profile: route.profile,
          provider: route.provider,
          ...summarizeLlmRequestPayload(requestPayload)
        });

        const resp = await provider.send({
          route,
          requestUrl,
          payload: requestPayload,
          signal: ctrl.signal
        });
        status = resp.status;
        ok = resp.ok;
        contentType = String(resp.headers.get("content-type") || "");

        if (!ok) {
          rawBody = await resp.text();
          const retryDelayHintMs = extractRetryDelayHintMs(rawBody, resp);
          orchestrator.events.emit(
            "llm.response.raw",
            sessionId,
            buildLlmRawTracePayload({
              step,
              attempt,
              status,
              ok,
              retryDelayHintMs,
              body: rawBody
            })
          );
          if (retryDelayHintMs != null && llmMaxRetryDelayMs > 0 && retryDelayHintMs > llmMaxRetryDelayMs) {
            const exceeded = new Error(
              `LLM retry delay ${Math.ceil(retryDelayHintMs / 1000)}s exceeds cap ${Math.ceil(llmMaxRetryDelayMs / 1000)}s`
            ) as RuntimeErrorWithMeta;
            exceeded.code = "E_LLM_RETRY_DELAY_EXCEEDED";
            exceeded.status = status;
            exceeded.details = {
              retryDelayHintMs,
              llmMaxRetryDelayMs
            };
            exceeded.retryable = false;
            throw exceeded;
          }
          const err = new Error(`LLM HTTP ${status}`) as Error & { status?: number };
          err.status = status;
          throw err;
        }

        let message: JsonRecord;
        const lowerType = contentType.toLowerCase();
        if (resp.body && lowerType.includes("text/event-stream")) {
          orchestrator.events.emit("llm.stream.start", sessionId, {
            step,
            attempt
          });
          const streamed = await readLlmMessageFromSseStream(resp.body, (chunk) => {
            if (!chunk) return;
            orchestrator.events.emit("llm.stream.delta", sessionId, {
              step,
              attempt,
              text: chunk
            });
          });
          rawBody = streamed.rawBody;
          message = streamed.message;
          orchestrator.events.emit("llm.stream.end", sessionId, {
            step,
            attempt,
            packetCount: streamed.packetCount,
            contentLength: parseLlmContent(message).length,
            toolCalls: normalizeToolCalls(message.tool_calls).length
          });
        } else {
          rawBody = await resp.text();
          message = parseLlmMessageFromBody(rawBody, contentType);
        }

        orchestrator.events.emit(
          "llm.response.raw",
          sessionId,
          buildLlmRawTracePayload({
            step,
            attempt,
            status,
            ok,
            body: rawBody
          })
        );
        const afterResponse = await orchestrator.runHook("llm.after_response", {
          request: {
            sessionId,
            step,
            attempt,
            profile: route.profile,
            provider: route.provider,
            url: requestUrl,
            payload: requestPayload,
            status,
            ok
          },
          response: message
        });
        if (afterResponse.blocked) {
          throw createNonRetryableRuntimeError("E_LLM_HOOK_BLOCKED", `llm.after_response blocked: ${afterResponse.reason || "blocked"}`);
        }
        if (!isPlainJsonRecord(afterResponse.value.response)) {
          throw createNonRetryableRuntimeError("E_LLM_HOOK_INVALID_PATCH", "llm.after_response patch response must be an object");
        }
        message = afterResponse.value.response;

        const state = orchestrator.getRunState(sessionId);
        if (state.retry.active) {
          orchestrator.resetRetryState(sessionId);
          orchestrator.events.emit("auto_retry_end", sessionId, {
            success: true,
            attempt: attempt - 1,
            maxAttempts: state.retry.maxAttempts
          });
        }

        return message;
      } catch (error) {
        const err = asRuntimeErrorWithMeta(error);
        lastError = err;
        const errText = error instanceof Error ? error.message : String(error);
        const statusCode = Number(err?.status || status || 0);
        const signalReason = String(ctrl.signal.reason || "");
        const retryable =
          typeof err.retryable === "boolean"
            ? err.retryable
            : isRetryableLlmStatus(statusCode) || /timeout|network|temporar|unavailable|rate limit/i.test(`${errText} ${signalReason}`);
        const canRetry = retryable && attempt <= maxAttempts;
        if (!canRetry) {
          err.details = {
            ...toRecord(err.details),
            retryAttempts: attempt,
            totalAttempts,
            status: statusCode || null,
            profile: route.profile,
            provider: route.provider
          };
          const state = orchestrator.getRunState(sessionId);
          if (state.retry.active) {
            orchestrator.events.emit("auto_retry_end", sessionId, {
              success: false,
              attempt: state.retry.attempt,
              maxAttempts: state.retry.maxAttempts,
              finalError: errText
            });
          }
          orchestrator.resetRetryState(sessionId);
          throw err;
        }

        const delayMs = computeRetryDelayMs(attempt);
        const next = orchestrator.updateRetryState(sessionId, {
          active: true,
          attempt,
          delayMs
        });
        orchestrator.events.emit("auto_retry_start", sessionId, {
          attempt,
          maxAttempts: next.retry.maxAttempts,
          delayMs,
          status: statusCode || null,
          reason: errText
        });
        await delay(delayMs);
      } finally {
        clearTimeout(timer);
      }
    }

    const finalError = asRuntimeErrorWithMeta(lastError || new Error("LLM request failed"));
    finalError.details = {
      ...toRecord(finalError.details),
      retryAttempts: totalAttempts,
      totalAttempts,
      profile: route.profile,
      provider: route.provider
    };
    throw finalError;
  }

  async function runAgentLoop(sessionId: string, prompt: string): Promise<void> {
    const stateAtStart = orchestrator.getRunState(sessionId);
    if (stateAtStart.stopped) {
      orchestrator.setRunning(sessionId, false);
      orchestrator.events.emit("loop_skip_stopped", sessionId, {
        reason: "stopped_before_run"
      });
      return;
    }

    const cfgRaw = await callInfra(infra, { type: "config.get" });
    const config = extractLlmConfig(cfgRaw);
    const maxLoopSteps = normalizeIntInRange(config.maxSteps, 100, 1, 500);
    const sessionMeta = await orchestrator.sessions.getMeta(sessionId);
    const routePrefs = readSessionLlmRoutePrefs(sessionMeta);
    const routeResolved = resolveLlmRoute({
      config,
      profile: routePrefs.profile,
      role: routePrefs.role,
      escalationPolicy: routePrefs.escalationPolicy
    });
    if (!routeResolved.ok) {
      const text = routeResolved.message;
      orchestrator.events.emit("llm.route.blocked", sessionId, {
        reason: routeResolved.reason,
        profile: routeResolved.profile,
        role: routeResolved.role
      });
      orchestrator.events.emit("llm.skipped", sessionId, {
        reason: routeResolved.reason,
        profile: routeResolved.profile,
        role: routeResolved.role
      });
      await orchestrator.sessions.appendMessage({
        sessionId,
        role: "assistant",
        text
      });
      orchestrator.setRunning(sessionId, false);
      orchestrator.events.emit("loop_done", sessionId, {
        status: "failed_execute",
        llmSteps: 0,
        toolSteps: 0
      });
      return;
    }
    let activeRoute = routeResolved.route;
    if (!llmProviders.has(activeRoute.provider)) {
      const text = `执行失败：未找到 LLM provider（${activeRoute.provider}）。`;
      orchestrator.events.emit("llm.route.blocked", sessionId, {
        reason: "provider_not_found",
        ...buildLlmRoutePayload(activeRoute)
      });
      orchestrator.events.emit("llm.skipped", sessionId, {
        reason: "provider_not_found",
        ...buildLlmRoutePayload(activeRoute)
      });
      await orchestrator.sessions.appendMessage({
        sessionId,
        role: "assistant",
        text
      });
      orchestrator.setRunning(sessionId, false);
      orchestrator.events.emit("loop_done", sessionId, {
        status: "failed_execute",
        llmSteps: 0,
        toolSteps: 0
      });
      return;
    }
    orchestrator.updateRetryState(sessionId, {
      maxAttempts: activeRoute.llmRetryMaxAttempts
    });

    orchestrator.events.emit("loop_start", sessionId, {
      prompt: clipText(prompt, 3000)
    });
    orchestrator.events.emit("llm.route.selected", sessionId, buildLlmRoutePayload(activeRoute, { source: "run_start" }));
    if (sessionMeta) {
      try {
        await writeSessionMeta(sessionId, withSessionLlmRouteMeta(sessionMeta, activeRoute));
      } catch {
        // ignore metadata write failures
      }
    }

    let llmStep = 0;
    let toolStep = 0;
    let finalStatus = "done";
    const llmFailureBySignature = new Map<string, number>();
    const focusEscalationReplayKeys = new Set<string>();

    try {
      await orchestrator.preSendCompactionCheck(sessionId);
      const context = await orchestrator.sessions.buildSessionContext(sessionId);
      const meta = await orchestrator.sessions.getMeta(sessionId);
      let availableSkillsPrompt = "";
      try {
        const skills = await orchestrator.listSkills();
        availableSkillsPrompt = buildAvailableSkillsSystemMessage(skills);
      } catch {
        availableSkillsPrompt = "";
      }
      const messages = buildLlmMessagesFromContext(config, meta, context.messages, context.previousSummary, availableSkillsPrompt);

      while (llmStep < maxLoopSteps) {
        let state = orchestrator.getRunState(sessionId);
        if (state.stopped) {
          finalStatus = "stopped";
          break;
        }
        while (state.paused && !state.stopped) {
          await delay(120);
          state = orchestrator.getRunState(sessionId);
        }
        if (state.stopped) {
          finalStatus = "stopped";
          break;
        }

        const dequeuedSteers = orchestrator.dequeueQueuedPrompts(sessionId, "steer");
        for (const steer of dequeuedSteers) {
          const steerText = await expandSkillSlashPrompt(sessionId, steer.text);
          await orchestrator.appendUserMessage(sessionId, steerText);
          await orchestrator.preSendCompactionCheck(sessionId);
          messages.push({
            role: "user",
            content: steerText
          });
          const runtimeAfterDequeue = orchestrator.getRunState(sessionId);
          orchestrator.events.emit("message.dequeued", sessionId, {
            behavior: "steer",
            id: steer.id,
            text: clipText(steerText, 3000),
            total: runtimeAfterDequeue.queue.total,
            steer: runtimeAfterDequeue.queue.steer,
            followUp: runtimeAfterDequeue.queue.followUp
          });
          orchestrator.events.emit("input.steer", sessionId, {
            text: clipText(steerText, 3000),
            id: steer.id
          });
        }

        llmStep += 1;
        const requestMessages = [
          ...messages,
          {
            role: "system",
            content: buildTaskProgressSystemMessage({
              llmStep,
              maxLoopSteps,
              toolStep,
              retryAttempt: Number(state.retry.attempt || 0),
              retryMaxAttempts: Number(state.retry.maxAttempts || activeRoute.llmRetryMaxAttempts)
            })
          }
        ];
        let message: JsonRecord;
        try {
          message = await requestLlmWithRetry({
            sessionId,
            route: activeRoute,
            providerRegistry: llmProviders,
            step: llmStep,
            messages: requestMessages,
            toolChoice: "auto",
            toolScope: "all"
          });
          llmFailureBySignature.clear();
        } catch (error) {
          const signature = buildLlmFailureSignature(error);
          const signatureHits = (llmFailureBySignature.get(signature) || 0) + 1;
          llmFailureBySignature.set(signature, signatureHits);
          const runtimeError = asRuntimeErrorWithMeta(error);
          const details = toRecord(runtimeError.details);
          const retryAttempts = Number(details.retryAttempts || 0);
          const repeatedFailure = retryAttempts > 1 || signatureHits > 1;
          if (repeatedFailure) {
            const decision = decideProfileEscalation({
              orderedProfiles: activeRoute.orderedProfiles,
              currentProfile: activeRoute.profile,
              repeatedFailure: true,
              policy: activeRoute.escalationPolicy
            });
            if (decision.type === "escalate") {
              const nextResolved = resolveLlmRoute({
                config,
                profile: decision.nextProfile,
                role: activeRoute.role,
                escalationPolicy: activeRoute.escalationPolicy
              });
              if (nextResolved.ok && llmProviders.has(nextResolved.route.provider)) {
                const fromRoute = activeRoute;
                activeRoute = nextResolved.route;
                llmFailureBySignature.clear();
                orchestrator.updateRetryState(sessionId, {
                  active: false,
                  attempt: 0,
                  delayMs: 0,
                  maxAttempts: activeRoute.llmRetryMaxAttempts
                });
                orchestrator.events.emit("llm.route.escalated", sessionId, {
                  signature,
                  signatureHits,
                  retryAttempts,
                  reason: decision.reason,
                  fromProfile: fromRoute.profile,
                  toProfile: activeRoute.profile,
                  fromProvider: fromRoute.provider,
                  toProvider: activeRoute.provider,
                  fromModel: fromRoute.llmModel,
                  toModel: activeRoute.llmModel
                });
                orchestrator.events.emit("llm.route.selected", sessionId, buildLlmRoutePayload(activeRoute, {
                  source: "escalation",
                  reason: decision.reason,
                  signature
                }));
                const latestMeta = await orchestrator.sessions.getMeta(sessionId);
                if (latestMeta) {
                  try {
                    await writeSessionMeta(sessionId, withSessionLlmRouteMeta(latestMeta, activeRoute));
                  } catch {
                    // ignore metadata write failures
                  }
                }
                continue;
              }
              orchestrator.events.emit("llm.route.blocked", sessionId, {
                reason: "provider_not_found",
                signature,
                requestedProfile: decision.nextProfile,
                ...buildLlmRoutePayload(activeRoute)
              });
              const blockedMessage = `执行失败：升级到 profile ${decision.nextProfile} 时未找到可用 provider。`;
              await orchestrator.sessions.appendMessage({
                sessionId,
                role: "assistant",
                text: blockedMessage
              });
              finalStatus = "failed_execute";
              throw new Error(blockedMessage);
            }
            if (decision.type === "blocked") {
              orchestrator.events.emit("llm.route.blocked", sessionId, {
                reason: decision.reason,
                signature,
                signatureHits,
                retryAttempts,
                ...buildLlmRoutePayload(activeRoute)
              });
              const blockedMessage =
                decision.reason === "no_higher_profile"
                  ? "执行失败：已达到当前角色可升级的最高 profile，无法继续自动升级。"
                  : `执行失败：当前 profile 未被升级链识别（${activeRoute.profile}）。`;
              await orchestrator.sessions.appendMessage({
                sessionId,
                role: "assistant",
                text: blockedMessage
              });
              finalStatus = "failed_execute";
              throw new Error(blockedMessage);
            }
          }
          throw error;
        }

        const assistantText = parseLlmContent(message).trim();
        const toolCalls = normalizeToolCalls(message.tool_calls);
        orchestrator.events.emit("llm.response.parsed", sessionId, {
          step: llmStep,
          toolCalls: toolCalls.length,
          hasText: !!assistantText
        });

        messages.push({
          role: "assistant",
          content: assistantText,
          tool_calls: toolCalls
        });

        // 仅在最终回答阶段（无工具调用）写入 assistant 文本。
        // 含 tool_calls 的中间思考阶段只通过流式态和工具步骤卡展示，避免正文被切碎成多段。
        if (toolCalls.length === 0) {
          await orchestrator.sessions.appendMessage({
            sessionId,
            role: "assistant",
            text: assistantText || "LLM 返回空内容。"
          });
        }

        if (toolCalls.length === 0) {
          orchestrator.events.emit("step_finished", sessionId, {
            step: llmStep,
            ok: true,
            mode: "llm",
            preview: clipText(assistantText, 1200)
          });
          break;
        }

        let skipRemainingToolCallsBySteer = false;
        for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
          if (orchestrator.getRunState(sessionId).stopped) {
            finalStatus = "stopped";
            break;
          }
          const tc = toolCalls[toolCallIndex];
          if (orchestrator.hasQueuedPrompt(sessionId, "steer")) {
            const skippedCount = toolCalls.length - toolCallIndex;
            skipRemainingToolCallsBySteer = true;
            orchestrator.events.emit("tool.skipped_due_to_steer", sessionId, {
              beforeTool: tc.function.name,
              beforeToolCallId: tc.id,
              skippedCount
            });
            break;
          }
          const canonicalToolName = String(orchestrator.resolveToolContract(tc.function.name)?.name || tc.function.name)
            .trim()
            .toLowerCase();
          toolStep += 1;
          orchestrator.events.emit("step_planned", sessionId, {
            step: toolStep,
            mode: "tool_call",
            action: tc.function.name,
            arguments: clipText(tc.function.arguments, 500)
          });

          let result = await executeToolCall(sessionId, tc);
          if (result.error) {
            const modeEscalation = toRecord(result.modeEscalation);
            const focusEscalationKey = `${String(tc.id || "")}|${String(tc.function.name || "").trim().toLowerCase()}`;
            const canAutoEscalateToFocus =
              [
                "click",
                "fill_element_by_uid",
                "select_option_by_uid",
                "hover_element_by_uid",
                "press_key",
                "scroll_page",
                "navigate_tab",
                "scroll_to_element",
                "highlight_element",
                "highlight_text_inline",
                "fill_form"
              ].includes(canonicalToolName) &&
              result.retryable === true &&
              normalizeFailureReason(result.errorReason) === "failed_execute" &&
              modeEscalation.suggested === true &&
              String(modeEscalation.to || "").trim().toLowerCase() === "focus" &&
              !focusEscalationReplayKeys.has(focusEscalationKey);
            if (canAutoEscalateToFocus) {
              const escalatedToolCall = buildFocusEscalationToolCall(tc);
              if (escalatedToolCall) {
                focusEscalationReplayKeys.add(focusEscalationKey);
                orchestrator.events.emit("tool.mode_escalation", sessionId, {
                  step: toolStep,
                  tool: tc.function.name,
                  toolCallId: tc.id,
                  from: String(modeEscalation.from || "background"),
                  to: "focus",
                  status: "retrying"
                });
                const escalatedResult = await executeToolCall(sessionId, escalatedToolCall);
                if (!escalatedResult.error) {
                  const escalatedResponse = toRecord(escalatedResult.response);
                  const escalatedData = escalatedResponse.data;
                  if (escalatedData && typeof escalatedData === "object" && !Array.isArray(escalatedData)) {
                    escalatedResponse.data = {
                      ...(escalatedData as JsonRecord),
                      modeEscalated: true,
                      modeEscalation: {
                        from: String(modeEscalation.from || "background"),
                        to: "focus",
                        auto: true
                      }
                    };
                  }
                  result = {
                    ...escalatedResult,
                    response: escalatedResponse
                  };
                  orchestrator.events.emit("tool.mode_escalation", sessionId, {
                    step: toolStep,
                    tool: tc.function.name,
                    toolCallId: tc.id,
                    from: String(modeEscalation.from || "background"),
                    to: "focus",
                    status: "recovered"
                  });
                } else {
                  result = escalatedResult;
                  orchestrator.events.emit("tool.mode_escalation", sessionId, {
                    step: toolStep,
                    tool: tc.function.name,
                    toolCallId: tc.id,
                    from: String(modeEscalation.from || "background"),
                    to: "focus",
                    status: "failed",
                    error: String(escalatedResult.error || "unknown")
                  });
                }
              }
            }
          }

          if (result.error) {
            const errorCode = normalizeErrorCode(result.errorCode);
            const interruptedBySteer =
              errorCode === "E_BRIDGE_INTERRUPTED" &&
              orchestrator.hasQueuedPrompt(sessionId, "steer");
            if (interruptedBySteer) {
              const skippedCount = toolCalls.length - toolCallIndex - 1;
              orchestrator.events.emit("tool.interrupted_by_steer", sessionId, {
                step: toolStep,
                action: tc.function.name,
                toolCallId: tc.id,
                skippedCount
              });
              orchestrator.events.emit("step_finished", sessionId, {
                step: toolStep,
                ok: false,
                mode: "tool_call",
                action: tc.function.name,
                error: "interrupted_by_steer"
              });
              skipRemainingToolCallsBySteer = true;
              break;
            }
            const failurePayload = buildToolFailurePayload(tc, result);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: safeStringify(
                failurePayload,
                6000
              )
            });
            await orchestrator.sessions.appendMessage({
              sessionId,
              role: "tool",
              text: safeStringify(failurePayload, 10_000),
              toolName: tc.function.name,
              toolCallId: tc.id
            });
            orchestrator.events.emit("step_finished", sessionId, {
              step: toolStep,
              ok: false,
              mode: "tool_call",
              action: tc.function.name,
              error: String(result.error)
            });
            // PI 对齐：工具失败写入 tool_result 后继续当前 loop，由后续 LLM 结合失败结果重规划。
            continue;
          }

          const responsePayload = toRecord(result.response);
          const rawToolData = responsePayload.data ?? result;
          const llmToolContent = safeStringify(rawToolData, 12_000);
          const uiToolPayload = buildToolSuccessPayload(tc, rawToolData);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: llmToolContent
          });
          await orchestrator.sessions.appendMessage({
            sessionId,
            role: "tool",
            text: clipText(safeStringify(uiToolPayload, 10_000), 10_000),
            toolName: tc.function.name,
            toolCallId: tc.id
          });
          orchestrator.events.emit("step_finished", sessionId, {
            step: toolStep,
            ok: true,
            mode: "tool_call",
            action: tc.function.name,
            preview: clipText(llmToolContent, 800)
          });

          if (toolCallIndex < toolCalls.length - 1 && orchestrator.hasQueuedPrompt(sessionId, "steer")) {
            const skippedCount = toolCalls.length - toolCallIndex - 1;
            skipRemainingToolCallsBySteer = true;
            orchestrator.events.emit("tool.skipped_due_to_steer", sessionId, {
              afterTool: tc.function.name,
              afterToolCallId: tc.id,
              skippedCount
            });
            break;
          }
        }

        if (finalStatus === "stopped") {
          break;
        }
        if (skipRemainingToolCallsBySteer) {
          continue;
        }
      }

      if (llmStep >= maxLoopSteps) {
        finalStatus = "max_steps";
        await orchestrator.sessions.appendMessage({
          sessionId,
          role: "assistant",
          text: `已达到最大步数 ${maxLoopSteps}，结束本轮执行。`
        });
      }
    } catch (error) {
      const runtimeError = asRuntimeErrorWithMeta(error);
      const message = runtimeError.message || String(error);
      const errorCode = normalizeErrorCode(runtimeError.code);
      const stoppedByUser = orchestrator.getRunState(sessionId).stopped || errorCode === "E_BRIDGE_ABORTED";
      if (stoppedByUser) {
        finalStatus = "stopped";
      } else {
        if (!String(message || "").includes("工具")) {
          await orchestrator.sessions.appendMessage({
            sessionId,
            role: "assistant",
            text: `执行失败：${message}`
          });
          if (finalStatus === "done") {
            finalStatus = "failed_execute";
          }
        }
        orchestrator.events.emit("loop_error", sessionId, {
          message
        });
      }
    } finally {
      try {
        await refreshSessionTitleAuto(orchestrator, sessionId, infra, llmProviders);
      } catch (titleError) {
        orchestrator.events.emit("session_title_auto_update_failed", sessionId, {
          error: titleError instanceof Error ? titleError.message : String(titleError)
        });
      }
      orchestrator.setRunning(sessionId, false);
      orchestrator.events.emit("loop_done", sessionId, {
        status: finalStatus,
        llmSteps: llmStep,
        toolSteps: toolStep
      });
      const runtimeAfterDone = orchestrator.getRunState(sessionId);
      if (!runtimeAfterDone.stopped && runtimeAfterDone.queue.followUp > 0) {
        const followUps = orchestrator.dequeueQueuedPrompts(sessionId, "followUp");
        const nextFollowUp = followUps[0];
        if (nextFollowUp) {
          const runtimeAfterDequeue = orchestrator.getRunState(sessionId);
          orchestrator.events.emit("message.dequeued", sessionId, {
            behavior: "followUp",
            id: nextFollowUp.id,
            text: clipText(nextFollowUp.text, 3000),
            total: runtimeAfterDequeue.queue.total,
            steer: runtimeAfterDequeue.queue.steer,
            followUp: runtimeAfterDequeue.queue.followUp
          });
          orchestrator.events.emit("loop_follow_up_start", sessionId, {
            id: nextFollowUp.id,
            text: clipText(nextFollowUp.text, 3000)
          });
          void startFromPrompt({
            sessionId,
            prompt: nextFollowUp.text,
            autoRun: true
          }).catch((error) => {
            orchestrator.events.emit("loop_internal_error", sessionId, {
              error: error instanceof Error ? error.message : String(error),
              reason: "follow_up_start_failed"
            });
          });
        }
      }
    }
  }

  async function applySharedTabs(sessionId: string, tabIdsInput: unknown[]): Promise<void> {
    const tabIds = normalizeTabIds(tabIdsInput);
    const allTabs = await queryAllTabsForRuntime();
    const byId = new Map(allTabs.map((tab) => [Number(tab.id), tab]));
    const sharedTabs = tabIds
      .map((id) => byId.get(id))
      .filter((tab): tab is { id: number; windowId: number; index: number; active: boolean; pinned: boolean; title: string; url: string } => Boolean(tab))
      .map((tab) => ({
        id: Number(tab.id),
        title: String(tab.title || ""),
        url: String(tab.url || "")
      }));

    const meta = await orchestrator.sessions.getMeta(sessionId);
    if (meta) {
      const header = toRecord(meta.header);
      const metadata = toRecord(header.metadata);
      if (sharedTabs.length > 0) {
        metadata.sharedTabs = sharedTabs;
        const currentPrimary = parsePositiveInt(metadata.primaryTabId);
        const sharedTabIds = sharedTabs.map((tab) => Number(tab.id)).filter((id) => Number.isInteger(id) && id > 0);
        metadata.primaryTabId =
          currentPrimary && sharedTabIds.includes(currentPrimary) ? currentPrimary : Number(sharedTabs[0].id);
      } else {
        delete metadata.sharedTabs;
        delete metadata.primaryTabId;
      }
      await writeSessionMeta(sessionId, {
        ...meta,
        header: {
          ...meta.header,
          metadata
        }
      });
    }

    orchestrator.events.emit("input.shared_tabs", sessionId, {
      providedTabIds: tabIds,
      resolvedCount: sharedTabs.length,
      primaryTabId: sharedTabs.length > 0 ? Number(sharedTabs[0].id) : null
    });
  }

  function parseSkillSlashPrompt(prompt: string): { skillId: string; argsText: string } | null {
    const text = String(prompt || "").trim();
    if (!text.startsWith("/skill:")) return null;
    const rest = text.slice("/skill:".length).trim();
    if (!rest) {
      throw new Error("skill 命令格式错误：请使用 /skill:<skillId> [args]");
    }
    const firstSpace = rest.search(/\s/);
    if (firstSpace < 0) {
      return {
        skillId: rest,
        argsText: ""
      };
    }
    return {
      skillId: rest.slice(0, firstSpace).trim(),
      argsText: rest.slice(firstSpace + 1).trim()
    };
  }

  function buildSkillCommandPrompt(input: {
    promptBlock: string;
    argsText: string;
    skillId: string;
    skillName: string;
  }): string {
    const parts = [
      "以下是通过 /skill 显式选择的技能，请先阅读并严格按技能流程执行：",
      input.promptBlock
    ];
    if (input.argsText) {
      parts.push(`<skill_args>\n${input.argsText}\n</skill_args>`);
    }
    parts.push(`说明：你当前执行的技能是 ${input.skillName}（id=${input.skillId}）。`);
    return parts.join("\n\n");
  }

  async function expandSkillSlashPrompt(sessionId: string, prompt: string): Promise<string> {
    const parsed = parseSkillSlashPrompt(prompt);
    if (!parsed) return String(prompt || "");
    const resolved = await orchestrator.resolveSkillContent(parsed.skillId, {
      sessionId,
      capability: TOOL_CAPABILITIES.read_file
    });
    return buildSkillCommandPrompt({
      promptBlock: resolved.promptBlock,
      argsText: parsed.argsText,
      skillId: resolved.skill.id,
      skillName: resolved.skill.name
    });
  }

  async function startLoopIfNeeded(sessionId: string, prompt: string, restartReason: string): Promise<RuntimeView> {
    const state = orchestrator.getRunState(sessionId);
    if (state.running) {
      orchestrator.events.emit("loop_enqueue_skipped", sessionId, {
        reason: state.stopped ? "stop_in_progress" : "already_running"
      });
      return orchestrator.getRunState(sessionId);
    }

    if (state.stopped) {
      orchestrator.restart(sessionId);
      orchestrator.events.emit("loop_restart", sessionId, {
        reason: restartReason
      });
    }

    orchestrator.setRunning(sessionId, true);
    void runAgentLoop(sessionId, prompt)
      .catch((error) => {
        orchestrator.events.emit("loop_internal_error", sessionId, {
          error: error instanceof Error ? error.message : String(error)
        });
      });

    return orchestrator.getRunState(sessionId);
  }

  async function startFromPrompt(input: RunStartInput): Promise<{ sessionId: string; runtime: RuntimeView }> {
    let sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    if (!sessionId) {
      const created = await orchestrator.createSession(input.sessionOptions || {});
      sessionId = created.sessionId;
    } else {
      const existed = await orchestrator.sessions.getMeta(sessionId);
      if (!existed) {
        await orchestrator.sessions.createSession({
          ...input.sessionOptions,
          id: sessionId
        });
      }
    }

    const hasExplicitTabIds = Array.isArray(input.tabIds);
    if (hasExplicitTabIds) {
      await applySharedTabs(sessionId, normalizeTabIds(input.tabIds || []));
    } else {
      const inferredTabIds = extractTabIdsFromPrompt(String(input.prompt || ""));
      if (inferredTabIds.length > 0) {
        await applySharedTabs(sessionId, inferredTabIds);
        orchestrator.events.emit("input.tab_ids_inferred", sessionId, {
          tabIds: inferredTabIds
        });
      }
    }

    const rawPrompt = String(input.prompt || "").trim();
    if (!rawPrompt) {
      return {
        sessionId,
        runtime: orchestrator.getRunState(sessionId)
      };
    }
    const prompt = await expandSkillSlashPrompt(sessionId, rawPrompt);

    const behavior = normalizeStreamingBehavior(input.streamingBehavior);
    const state = orchestrator.getRunState(sessionId);
    if (state.running) {
      if (!behavior) {
        throw new Error("会话正在运行中；请显式指定 streamingBehavior=steer|followUp");
      }
      const queuedRuntime = orchestrator.enqueueQueuedPrompt(sessionId, behavior, prompt);
      orchestrator.events.emit("message.queued", sessionId, {
        behavior,
        text: clipText(prompt, 3000),
        total: queuedRuntime.queue.total,
        steer: queuedRuntime.queue.steer,
        followUp: queuedRuntime.queue.followUp
      });
      if (behavior === "followUp") {
        orchestrator.events.emit("loop_follow_up_queued", sessionId, {
          text: clipText(prompt, 3000),
          total: queuedRuntime.queue.followUp
        });
      }
      return {
        sessionId,
        runtime: queuedRuntime
      };
    }

    await orchestrator.appendUserMessage(sessionId, prompt);
    orchestrator.events.emit("input.user", sessionId, {
      text: clipText(prompt, 3000)
    });

    if (input.autoRun === false) {
      return {
        sessionId,
        runtime: orchestrator.getRunState(sessionId)
      };
    }

    return {
      sessionId,
      runtime: await startLoopIfNeeded(sessionId, prompt, "restart_after_stop")
    };
  }

  async function startFromRegenerate(input: RegenerateRunInput): Promise<{ sessionId: string; runtime: RuntimeView }> {
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) throw new Error("sessionId 不能为空");
    await orchestrator.sessions.ensureSession(sessionId);
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw new Error("regenerate prompt 不能为空");

    if (input.autoRun === false) {
      return {
        sessionId,
        runtime: orchestrator.getRunState(sessionId)
      };
    }

    return {
      sessionId,
      runtime: await startLoopIfNeeded(sessionId, prompt, "restart_after_regenerate")
    };
  }

  return {
    startFromPrompt,
    startFromRegenerate,
    executeStep,
    async refreshSessionTitle(sessionId: string, options: { force?: boolean } = {}): Promise<string> {
      await refreshSessionTitleAuto(orchestrator, sessionId, infra, llmProviders, options);
      const meta = await orchestrator.sessions.getMeta(sessionId);
      return normalizeSessionTitle(meta?.header.title, "");
    },
    async getSystemPromptPreview(): Promise<string> {
      const cfgRaw = await callInfra(infra, { type: "config.get" });
      const cfg = extractLlmConfig(cfgRaw);
      return buildBrowserAgentSystemPrompt(cfg);
    }
  };
}
