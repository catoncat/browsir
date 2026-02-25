import {
  BrainOrchestrator,
  type ExecuteCapability,
  type ExecuteMode,
  type ExecuteStepResult,
  type RuntimeView
} from "./orchestrator.browser";
import { SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.browser";
import { writeSessionMeta } from "./session-store.browser";
import { type BridgeConfig, type RuntimeInfraHandler } from "./runtime-infra.browser";
import { type CapabilityExecutionPolicy, type StepVerifyPolicy } from "./capability-policy";
import { nowIso, type SessionEntry, type SessionMeta } from "./types";

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
const LLM_TRACE_BODY_MAX_CHARS = 4_000;
const LLM_TRACE_USER_SNIPPET_MAX_CHARS = 420;
const TOOL_RETRYABLE_FAILURE_MAX_TOTAL = 8;
const TOOL_RETRYABLE_FAILURE_MAX_PER_SIGNATURE = 3;

type ToolRetryAction = "auto_replay" | "llm_replan" | "fail_fast";

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
}

interface RegenerateRunInput {
  sessionId: string;
  prompt: string;
  autoRun?: boolean;
}

interface LlmRequestInput {
  sessionId: string;
  llmBase: string;
  llmKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmMaxRetryDelayMs: number;
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
}

const TOOL_CAPABILITIES = {
  bash: "process.exec",
  read_file: "fs.read",
  write_file: "fs.write",
  edit_file: "fs.edit",
  snapshot: "browser.snapshot",
  browser_action: "browser.action",
  browser_verify: "browser.verify"
} as const;

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

const BUILTIN_BROWSER_CAPABILITY_PROVIDERS: Array<{ capability: ExecuteCapability; providerId: string }> = [
  {
    capability: TOOL_CAPABILITIES.snapshot,
    providerId: "runtime.builtin.capability.browser.snapshot.cdp"
  },
  {
    capability: TOOL_CAPABILITIES.browser_action,
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
  "list_tabs",
  "open_tab",
  "snapshot",
  "browser_action",
  "browser_verify"
]);

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
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
    body: clipText(body, LLM_TRACE_BODY_MAX_CHARS),
    bodyLength: body.length,
    bodyTruncated: body.length > LLM_TRACE_BODY_MAX_CHARS
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
  return ["write_file", "edit_file", "browser_action", "open_tab"].includes(normalized);
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

  if (normalizedCode === "E_NO_TAB" || normalizedCode === "E_VERIFY_FAILED") {
    return {
      action: "llm_replan",
      retryable: true,
      retryHint: "Refresh context (list_tabs/snapshot) and retry with updated target."
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

function shouldRequireBrowserProof(prompt: string): boolean {
  const text = String(prompt || "");
  if (!/tabid\s*[:=]\s*\d+/i.test(text)) return false;
  return /(fill|click|type|navigate|verify|selector|browser_action|browser_verify|页面|填写|点击|输入|验证)/i.test(text);
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

function parseToolCallArgs(raw: string): JsonRecord | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as JsonRecord;
}

function summarizeToolTarget(toolName: string, args: JsonRecord | null, rawArgs: string): string {
  const normalized = String(toolName || "").trim().toLowerCase();
  const raw = String(rawArgs || "").trim();
  const pick = (key: string) => String(args?.[key] || "").trim();

  if (normalized === "bash") {
    const command = pick("command") || raw;
    return command ? `命令：${clipText(command, 220)}` : "";
  }
  if (normalized === "open_tab") {
    const url = pick("url");
    return url ? `目标：${clipText(url, 220)}` : "";
  }
  if (["read_file", "write_file", "edit_file"].includes(normalized)) {
    const path = pick("path");
    return path ? `路径：${clipText(path, 220)}` : "";
  }
  if (normalized === "snapshot") {
    const mode = pick("mode") || "interactive";
    const selector = pick("selector");
    return selector ? `模式：${mode} · 选择器：${clipText(selector, 120)}` : `模式：${mode}`;
  }
  if (normalized === "browser_action") {
    const kind = pick("kind");
    const target = pick("url") || pick("ref") || pick("selector");
    if (kind && target) return `${kind} · ${clipText(target, 180)}`;
    if (kind) return `动作：${kind}`;
  }
  if (normalized === "browser_verify") return "页面验证";
  if (normalized === "list_tabs") return "读取标签页列表";
  if (raw) return `参数：${clipText(raw, 220)}`;
  return "";
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
    details: result.details || null
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
    "Use this context directly before deciding whether to call list_tabs/open_tab.",
    "For browser tasks, do not claim done until browser actions are verified."
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

function buildLlmMessagesFromContext(meta: SessionMeta | null, contextMessages: Array<{ role: string; content: string }>): JsonRecord[] {
  const out: JsonRecord[] = [];
  out.push({
    role: "system",
    content: [
      "Tool retry policy:",
      "1) For transient tool errors (retryable=true), retry the same goal with adjusted parameters.",
      "2) bash supports optional timeoutMs (milliseconds). Increase timeoutMs when timeout-related failures happen.",
      "3) For non-retryable errors, stop retrying and explain the blocker clearly.",
      "4) A short task progress note will be provided each round via system message."
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

  for (const item of contextMessages) {
    const rawRole = String(item.role || "assistant").toLowerCase();
    let role = rawRole;
    let content = String(item.content || "");
    if (!content.trim()) continue;
    if (rawRole === "tool") {
      role = "assistant";
      content = `工具执行结果（历史）:\n${content}`;
    } else if (!["system", "user", "assistant"].includes(rawRole)) {
      role = "assistant";
    }
    out.push({ role, content });
  }

  if (out.length === 0) {
    out.push({ role: "user", content: "继续当前任务。" });
  }

  return out;
}

function shouldVerifyStep(action: string, verifyPolicy: unknown): boolean {
  const policy = String(verifyPolicy || "on_critical");
  if (policy === "off") return false;
  if (policy === "always") return true;
  const critical = ["click", "type", "fill", "press", "scroll", "select", "navigate", "browser_action", "action"];
  return critical.includes(String(action || "").trim().toLowerCase());
}

function actionRequiresLease(kind: string): boolean {
  return ["click", "type", "fill", "press", "scroll", "select", "navigate"].includes(kind);
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
    errorReason?: "failed_execute" | "failed_verify";
  } = {}
): JsonRecord {
  const errorCode = normalizeErrorCode(out.errorCode);
  const defaultRetryable = options.defaultRetryable === true;
  return {
    error: out.error || fallbackError,
    errorCode: errorCode || undefined,
    errorReason: options.errorReason || "failed_execute",
    retryable: out.retryable === true || defaultRetryable || isRetryableToolErrorCode(toolName, errorCode),
    retryHint,
    details: out.errorDetails || null
  };
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
  llmBase: string;
  llmKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  messages: { role: string; content: string }[];
}): Promise<string> {
  const { llmBase, llmKey, llmModel, llmTimeoutMs, messages } = input;
  if (!llmBase || !llmKey || messages.length === 0) return "";

  const systemPrompt = "你是一个专业助手。请根据提供的对话内容，生成一个非常简短、精准的标题（不超过 10 个字）。直接返回标题文本，不要包含引号、序号或任何解释。";
  const userContent = messages
    .slice(0, 5) // 取前 5 条消息以节省 token 并加速响应
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${clipText(m.content, 200)}`)
    .join("\n");

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("title-timeout"), Math.min(30_000, llmTimeoutMs));
    try {
      const response = await fetch(`${llmBase.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmKey}`
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: llmModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `请总结以下对话的标题：\n\n${userContent}` }
          ],
          max_tokens: 30,
          temperature: 0.3
        })
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
  sessionId: string;
  mode: "history" | "turn_prefix";
  promptText: string;
  maxTokens: number;
}): Promise<string> {
  const cfgRaw = await callInfra(input.infra, { type: "config.get" });
  const config = extractLlmConfig(cfgRaw);
  const llmBase = String(config.llmApiBase || "").trim();
  const llmKey = String(config.llmApiKey || "").trim();
  const llmModel = String(config.llmModel || "gpt-5.3-codex").trim();
  const llmTimeoutMs = normalizeIntInRange(config.llmTimeoutMs, DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS);
  if (!llmBase || !llmKey) {
    throw new Error("compaction summary 需要可用 LLM（llmApiBase/llmApiKey）");
  }

  const baseUrl = `${llmBase.replace(/\/$/, "")}/chat/completions`;
  const payload: JsonRecord = {
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

  const beforeRequest = await input.orchestrator.runHook("llm.before_request", {
    request: {
      sessionId: input.sessionId,
      step: 0,
      attempt: 1,
      mode: input.mode,
      source: "compaction",
      url: baseUrl,
      payload
    }
  });
  if (beforeRequest.blocked) {
    throw new Error(`llm.before_request blocked: ${beforeRequest.reason || "blocked"}`);
  }
  const patchedRequest = toRecord(beforeRequest.value.request);
  const requestUrl = String(patchedRequest.url || baseUrl).trim() || baseUrl;
  const requestPayload = toRecord(patchedRequest.payload);

  input.orchestrator.events.emit("llm.request", input.sessionId, {
    step: 0,
    mode: "compaction",
    summaryMode: input.mode,
    url: requestUrl,
    model: llmModel,
    ...summarizeLlmRequestPayload(requestPayload)
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("compaction-summary-timeout"), llmTimeoutMs);
  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${llmKey}`
      },
      body: JSON.stringify(requestPayload),
      signal: ctrl.signal
    });

    const status = response.status;
    const ok = response.ok;
    const contentType = String(response.headers.get("content-type") || "");
    const rawBody = await response.text();
    input.orchestrator.events.emit(
      "llm.response.raw",
      input.sessionId,
      buildLlmRawTracePayload({
        step: 0,
        attempt: 1,
        status,
        ok,
        body: rawBody
      })
    );

    if (!ok) {
      throw new Error(`Compaction summary HTTP ${status}`);
    }

    const message = parseLlmMessageFromBody(rawBody, contentType);
    const afterResponse = await input.orchestrator.runHook("llm.after_response", {
      request: {
        sessionId: input.sessionId,
        step: 0,
        attempt: 1,
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
  } finally {
    clearTimeout(timer);
  }
}

async function refreshSessionTitleAuto(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  infra: RuntimeInfraHandler,
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
    llmBase: config.llmApiBase,
    llmKey: config.llmApiKey,
    llmModel: config.llmModel,
    llmTimeoutMs: config.llmTimeoutMs,
    messages: contextMessages
  });

  if (!derived) return;

  const nextMeta: SessionMeta = withSessionTitleMeta(meta, derived, SESSION_TITLE_SOURCE_AI);
  await writeSessionMeta(sessionId, nextMeta);
  orchestrator.events.emit("session_title_auto_updated", sessionId, { title: derived });
}

export function createRuntimeLoopController(orchestrator: BrainOrchestrator, infra: RuntimeInfraHandler): RuntimeLoopController {
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
          return String(frame.tool || "").trim().length > 0;
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
          if (item.capability === TOOL_CAPABILITIES.snapshot) {
            return await invokeBrowserSnapshotCapability(input);
          }
          if (item.capability === TOOL_CAPABILITIES.browser_action) {
            return await invokeBrowserActionCapability(input);
          }
          return await invokeBrowserVerifyCapability(input);
        }
      });
    }
  };

  ensureBuiltinBridgeCapabilityProviders();
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
        kind: "local.list_tabs";
      }
    | {
        kind: "local.open_tab";
        args: JsonRecord;
      }
    | {
        kind: "step.snapshot";
        capability: ExecuteCapability;
        tabId: number;
        options: JsonRecord;
      }
    | {
        kind: "step.browser_action";
        capability: ExecuteCapability;
        tabId: number;
        kindValue: string;
        action: JsonRecord;
        expect: unknown;
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
    return {
      error: unsupported
        ? `工具已注册但当前 runtime 不支持执行: ${input.requestedTool}`
        : `未知工具: ${input.requestedTool}`,
      errorCode: unsupported ? "E_TOOL_UNSUPPORTED" : "E_TOOL",
      details: {
        requestedTool: input.requestedTool,
        resolvedTool: input.resolvedTool,
        canonicalTool: input.resolvedTool || null,
        supportedTools: Array.from(RUNTIME_EXECUTABLE_TOOL_NAMES)
      }
    };
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

  async function buildToolPlan(
    sessionId: string,
    context: ResolvedToolCallContext
  ): Promise<{ ok: true; plan: ToolPlan } | { ok: false; error: JsonRecord }> {
    const args = context.args;
    switch (context.executionTool) {
      case "bash": {
        const command = String(args.command || "").trim();
        if (!command) return { ok: false, error: { error: "bash 需要 command" } };
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
        if (args.offset != null) invokeArgs.offset = args.offset;
        if (args.limit != null) invokeArgs.limit = args.limit;
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
                mode: String(args.mode || "overwrite")
              }
            }
          }
        };
      }
      case "edit_file": {
        const path = String(args.path || "").trim();
        if (!path) return { ok: false, error: { error: "edit_file 需要 path" } };
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
                edits: Array.isArray(args.edits) ? args.edits : []
              }
            }
          }
        };
      }
      case "list_tabs":
        return { ok: true, plan: { kind: "local.list_tabs" } };
      case "open_tab": {
        const rawUrl = String(args.url || "").trim();
        if (!rawUrl) return { ok: false, error: { error: "open_tab 需要 url" } };
        return {
          ok: true,
          plan: {
            kind: "local.open_tab",
            args: {
              url: rawUrl,
              active: args.active
            }
          }
        };
      }
      case "snapshot": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: {
              error: "snapshot 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call list_tabs and then retry snapshot with a valid tabId."
            }
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.snapshot",
            capability: TOOL_CAPABILITIES.snapshot,
            tabId,
            options: {
              mode: args.mode || "interactive",
              selector: args.selector || "",
              filter: args.filter || "interactive",
              format: args.format === "json" ? "json" : "compact",
              diff: args.diff !== false,
              maxTokens: args.maxTokens,
              depth: args.depth,
              noAnimations: args.noAnimations === true
            }
          }
        };
      }
      case "browser_action": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: {
              error: "browser_action 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call list_tabs and retry browser_action with a valid tabId."
            }
          };
        }
        const kindValue = String(args.kind || "").trim().toLowerCase();
        return {
          ok: true,
          plan: {
            kind: "step.browser_action",
            capability: TOOL_CAPABILITIES.browser_action,
            tabId,
            kindValue,
            action: {
              kind: kindValue,
              ref: args.ref,
              selector: args.selector,
              key: args.key || (kindValue === "press" ? args.value : undefined),
              value: args.value,
              url: args.url || (kindValue === "navigate" ? args.value : undefined),
              expect: args.expect
            },
            expect: args.expect
          }
        };
      }
      case "browser_verify": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: {
              error: "browser_verify 需要 tabId，当前无可用 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call list_tabs and retry browser_verify with a valid tabId."
            }
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.browser_verify",
            capability: TOOL_CAPABILITIES.browser_verify,
            tabId,
            verifyExpect: normalizeVerifyExpect(args.expect || args) || {}
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
      case "local.list_tabs": {
        const tabs = await queryAllTabsForRuntime();
        const activeTabId = await getActiveTabIdForRuntime();
        return buildToolResponseEnvelope("tabs", {
          count: tabs.length,
          activeTabId,
          tabs
        });
      }
      case "local.open_tab": {
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
      case "step.snapshot": {
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
            "snapshot",
            out,
            "snapshot 执行失败",
            "Take another snapshot (or list_tabs first) and retry with a valid tab/selector.",
            { defaultRetryable: true }
          );
        }
        const snapshotData = toRecord(out.data);
        return buildToolResponseEnvelope("snapshot", out.data, {
          capabilityUsed: out.capabilityUsed || plan.capability,
          modeUsed: out.modeUsed,
          verified: typeof snapshotData.verified === "boolean" ? snapshotData.verified : out.verified,
          verifyReason: String(snapshotData.verifyReason || out.verifyReason || "")
        });
      }
      case "step.browser_action": {
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
            "browser_action",
            out,
            "browser_action 执行失败",
            "Take a fresh snapshot and retry with updated ref/selector.",
            { defaultRetryable: true }
          );
        }
        const providerAction = toRecord(out.data);
        const verified = typeof providerAction.verified === "boolean" ? providerAction.verified : out.verified;
        const verifyReason = String(providerAction.verifyReason || out.verifyReason || "");
        const actionData = providerAction.data !== undefined ? providerAction.data : out.data;
        const explicitExpect = normalizeVerifyExpect(plan.expect || null);
        const hardFail = !!explicitExpect || plan.kindValue === "navigate";
        if (!verified && hardFail) {
          return {
            error: "browser_action 执行成功但未通过验证",
            errorCode: "E_VERIFY_FAILED",
            errorReason: "failed_verify",
            retryable: true,
            retryHint: "Adjust action args/expect and retry the browser action.",
            details: {
              verifyReason,
              data: actionData
            }
          };
        }
        return buildToolResponseEnvelope("cdp_action", actionData, {
          capabilityUsed: out.capabilityUsed || plan.capability,
          modeUsed: out.modeUsed,
          verifyReason,
          verified
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
            { defaultRetryable: true }
          );
        }
        const providerVerify = toRecord(out.data);
        const verified = typeof providerVerify.verified === "boolean" ? providerVerify.verified : out.verified;
        const verifyData = providerVerify.data !== undefined ? providerVerify.data : out.data;
        if (!verified) {
          return {
            error: "browser_verify 未通过",
            errorCode: "E_VERIFY_FAILED",
            errorReason: "failed_verify",
            retryable: true,
            retryHint: "Refine expect conditions and re-run browser_verify.",
            details: verifyData
          };
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

  async function executeToolCall(sessionId: string, toolCall: ToolCallItem): Promise<JsonRecord> {
    const resolved = resolveToolCallContext(toolCall);
    if (!resolved.ok) return resolved.error;
    const planResult = await buildToolPlan(sessionId, resolved.value);
    if (!planResult.ok) return planResult.error;
    return await dispatchToolPlan(sessionId, planResult.plan);
  }

  async function requestLlmWithRetry(input: LlmRequestInput): Promise<JsonRecord> {
    const { sessionId, llmBase, llmKey, llmModel, llmTimeoutMs, llmMaxRetryDelayMs, step, messages } = input;
    const toolChoice = input.toolChoice === "required" ? "required" : "auto";
    const toolScope = input.toolScope === "browser_only" ? "browser_only" : "all";
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
        const browserOnlyTools = new Set(["list_tabs", "open_tab", "snapshot", "browser_action", "browser_verify"]);
        const llmToolDefs = orchestrator
          .listLlmToolDefinitions({ includeAliases: true })
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
          });
        const basePayload: JsonRecord = {
          model: llmModel,
          messages,
          tools: llmToolDefs,
          tool_choice: toolChoice,
          temperature: 0.2,
          stream: true
        };
        const baseUrl = `${llmBase.replace(/\/$/, "")}/chat/completions`;
        const beforeRequest = await orchestrator.runHook("llm.before_request", {
          request: {
            sessionId,
            step,
            attempt,
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

        orchestrator.events.emit("llm.request", sessionId, {
          step,
          url: requestUrl,
          model: llmModel,
          ...summarizeLlmRequestPayload(requestPayload)
        });

        const resp = await fetch(requestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${llmKey}`
          },
          body: JSON.stringify(requestPayload),
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
        lastError = error;
        const err = error as RuntimeErrorWithMeta;
        const errText = error instanceof Error ? error.message : String(error);
        const statusCode = Number(err?.status || status || 0);
        const signalReason = String(ctrl.signal.reason || "");
        const retryable =
          typeof err.retryable === "boolean"
            ? err.retryable
            : isRetryableLlmStatus(statusCode) || /timeout|network|temporar|unavailable|rate limit/i.test(`${errText} ${signalReason}`);
        const canRetry = retryable && attempt <= maxAttempts;
        if (!canRetry) {
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
          throw error;
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

    throw lastError || new Error("LLM request failed");
  }

  async function runAgentLoop(sessionId: string, prompt: string): Promise<void> {
    const stateAtStart = orchestrator.getRunState(sessionId);
    if (stateAtStart.stopped) {
      orchestrator.events.emit("loop_skip_stopped", sessionId, {
        reason: "stopped_before_run"
      });
      return;
    }

    const cfgRaw = await callInfra(infra, { type: "config.get" });
    const config = extractLlmConfig(cfgRaw);
    const llmBase = String(config.llmApiBase || "").trim();
    const llmKey = String(config.llmApiKey || "").trim();
    const llmModel = String(config.llmModel || "gpt-5.3-codex").trim();
    const maxLoopSteps = normalizeIntInRange(config.maxSteps, 100, 1, 500);
    const llmTimeoutMs = normalizeIntInRange(config.llmTimeoutMs, DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS);
    const llmRetryMaxAttempts = normalizeIntInRange(config.llmRetryMaxAttempts, MAX_LLM_RETRIES, 0, 6);
    const llmMaxRetryDelayMs = normalizeIntInRange(
      config.llmMaxRetryDelayMs,
      DEFAULT_LLM_MAX_RETRY_DELAY_MS,
      MIN_LLM_MAX_RETRY_DELAY_MS,
      MAX_LLM_MAX_RETRY_DELAY_MS
    );
    orchestrator.updateRetryState(sessionId, {
      maxAttempts: llmRetryMaxAttempts
    });

    orchestrator.events.emit("loop_start", sessionId, {
      prompt: clipText(prompt, 3000)
    });

    if (!llmBase || !llmKey) {
      const text = "执行失败：当前未配置可用 LLM（llmApiBase/llmApiKey）。";
      orchestrator.events.emit("llm.skipped", sessionId, {
        reason: "missing_llm_config",
        hasBase: !!llmBase,
        hasKey: !!llmKey
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

    const context = await orchestrator.sessions.buildSessionContext(sessionId);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    const messages = buildLlmMessagesFromContext(
      meta,
      context.messages.map((item) => ({ role: String(item.role || ""), content: String(item.content || "") }))
    );

    let llmStep = 0;
    let toolStep = 0;
    let finalStatus = "done";
    const requireBrowserProof = shouldRequireBrowserProof(prompt);
    let browserProofSatisfied = false;
    const retryableFailureBySignature = new Map<string, number>();
    let retryableFailureTotal = 0;

    try {
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
              retryMaxAttempts: Number(state.retry.maxAttempts || llmRetryMaxAttempts)
            })
          }
        ];
        const message = await requestLlmWithRetry({
          sessionId,
          llmBase,
          llmKey,
          llmModel,
          llmTimeoutMs,
          llmMaxRetryDelayMs,
          step: llmStep,
          messages: requestMessages,
          toolChoice: requireBrowserProof && !browserProofSatisfied ? "required" : "auto",
          toolScope: requireBrowserProof ? "browser_only" : "all"
        });

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
          if (requireBrowserProof && !browserProofSatisfied) {
            messages.push({
              role: "system",
              content:
                "尚未完成可验证页面操作。请调用 browser_action/browser_verify 完成目标并验证后，再给出完成结论。"
            });
            orchestrator.events.emit("loop_guard_browser_progress_missing", sessionId, {
              step: llmStep
            });
            continue;
          }
          orchestrator.events.emit("step_finished", sessionId, {
            step: llmStep,
            ok: true,
            mode: "llm",
            preview: clipText(assistantText, 1200)
          });
          break;
        }

        let shouldContinueAfterToolFailure = false;
        for (const tc of toolCalls) {
          toolStep += 1;
          orchestrator.events.emit("step_planned", sessionId, {
            step: toolStep,
            mode: "tool_call",
            action: tc.function.name,
            arguments: clipText(tc.function.arguments, 500)
          });

          const result = await executeToolCall(sessionId, tc);
          if (result.error) {
            const failurePayload = buildToolFailurePayload(tc, result);
            const failureText = `工具 ${tc.function.name} 失败: ${String(result.error)}`;
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
            if (result.retryable === true) {
              const failureSignature = [
                String(tc.function.name || "").trim().toLowerCase(),
                String(failurePayload.errorCode || "").trim().toUpperCase(),
                String(failurePayload.target || "").trim().toLowerCase()
              ].join("|");
              const currentSignatureHits = (retryableFailureBySignature.get(failureSignature) || 0) + 1;
              retryableFailureBySignature.set(failureSignature, currentSignatureHits);
              retryableFailureTotal += 1;

              if (currentSignatureHits > TOOL_RETRYABLE_FAILURE_MAX_PER_SIGNATURE) {
                const circuitMessage = `工具 ${tc.function.name} 在同一目标连续失败，已停止自动重试。`;
                orchestrator.events.emit("retry_circuit_open", sessionId, {
                  tool: tc.function.name,
                  signature: failureSignature,
                  hits: currentSignatureHits,
                  maxPerSignature: TOOL_RETRYABLE_FAILURE_MAX_PER_SIGNATURE,
                  total: retryableFailureTotal
                });
                await orchestrator.sessions.appendMessage({
                  sessionId,
                  role: "assistant",
                  text: circuitMessage
                });
                finalStatus = result.errorReason === "failed_verify" ? "failed_verify" : "failed_execute";
                throw new Error(circuitMessage);
              }

              if (retryableFailureTotal > TOOL_RETRYABLE_FAILURE_MAX_TOTAL) {
                const budgetMessage = "可恢复失败次数已超出预算，已停止自动重试并结束本轮。";
                orchestrator.events.emit("retry_budget_exhausted", sessionId, {
                  total: retryableFailureTotal,
                  maxTotal: TOOL_RETRYABLE_FAILURE_MAX_TOTAL
                });
                await orchestrator.sessions.appendMessage({
                  sessionId,
                  role: "assistant",
                  text: budgetMessage
                });
                finalStatus = result.errorReason === "failed_verify" ? "failed_verify" : "failed_execute";
                throw new Error(budgetMessage);
              }

              shouldContinueAfterToolFailure = true;
              break;
            }

            await orchestrator.sessions.appendMessage({
              sessionId,
              role: "assistant",
              text: failureText
            });
            finalStatus = result.errorReason === "failed_verify" ? "failed_verify" : "failed_execute";
            throw new Error(failureText);
          }

          const responsePayload = toRecord(result.response);
          const rawToolData = responsePayload.data ?? result;
          const toolName = String(tc.function.name || "").trim().toLowerCase();
          if (toolName === "browser_action" || toolName === "browser_verify") {
            const verified = result.verified === true || String(result.verifyReason || "").trim() === "verified";
            if (verified || toolName === "browser_verify") {
              browserProofSatisfied = true;
            }
          }
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
        }

        if (shouldContinueAfterToolFailure) {
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
      const message = error instanceof Error ? error.message : String(error);
      if (!String(message || "").includes("工具")) {
        await orchestrator.sessions.appendMessage({
          sessionId,
          role: "assistant",
          text: `执行失败：${message}`
        });
        finalStatus = "failed_execute";
      }
      orchestrator.events.emit("loop_error", sessionId, {
        message
      });
    } finally {
      try {
        await refreshSessionTitleAuto(orchestrator, sessionId, infra);
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

  async function startLoopIfNeeded(sessionId: string, prompt: string, restartReason: string): Promise<RuntimeView> {
    const state = orchestrator.getRunState(sessionId);
    if (state.stopped) {
      orchestrator.restart(sessionId);
      orchestrator.events.emit("loop_restart", sessionId, {
        reason: restartReason
      });
    }

    if (!orchestrator.getRunState(sessionId).running) {
      orchestrator.setRunning(sessionId, true);
      void runAgentLoop(sessionId, prompt)
        .catch((error) => {
          orchestrator.events.emit("loop_internal_error", sessionId, {
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          orchestrator.setRunning(sessionId, false);
        });
    } else {
      orchestrator.events.emit("loop_enqueue_skipped", sessionId, {
        reason: "already_running"
      });
    }

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

    const prompt = String(input.prompt || "").trim();
    if (!prompt) {
      return {
        sessionId,
        runtime: orchestrator.getRunState(sessionId)
      };
    }

    await orchestrator.appendUserMessage(sessionId, prompt);
    await orchestrator.preSendCompactionCheck(sessionId);
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
      await refreshSessionTitleAuto(orchestrator, sessionId, infra, options);
      const meta = await orchestrator.sessions.getMeta(sessionId);
      return normalizeSessionTitle(meta?.header.title, "");
    }
  };
}
