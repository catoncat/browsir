import { BrainOrchestrator, type ExecuteMode, type ExecuteStepResult, type RuntimeView } from "./orchestrator.browser";
import { writeSessionMeta } from "./session-store.browser";
import { type BridgeConfig, type RuntimeInfraHandler } from "./runtime-infra.browser";
import { nowIso, type SessionEntry, type SessionMeta } from "./types";

type JsonRecord = Record<string, unknown>;

const MAX_LLM_RETRIES = 2;
const MAX_DEBUG_CHARS = 24_000;
const SESSION_TITLE_MAX = 28;
const SESSION_TITLE_MIN = 2;
const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const MIN_LLM_TIMEOUT_MS = 1_000;
const MAX_LLM_TIMEOUT_MS = 300_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MIN_BASH_TIMEOUT_MS = 200;
const MAX_BASH_TIMEOUT_MS = 300_000;
const TOOL_AUTO_RETRY_MAX = 2;
const TOOL_AUTO_RETRY_BASE_DELAY_MS = 300;
const TOOL_AUTO_RETRY_CAP_DELAY_MS = 2_000;

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
  step: number;
  messages: JsonRecord[];
}

type RuntimeErrorWithMeta = Error & {
  code?: string;
  details?: unknown;
  retryable?: boolean;
  status?: number;
};

interface RuntimeLoopController {
  startFromPrompt(input: RunStartInput): Promise<{ sessionId: string; runtime: RuntimeView }>;
  startFromRegenerate(input: RegenerateRunInput): Promise<{ sessionId: string; runtime: RuntimeView }>;
  executeStep(input: {
    sessionId: string;
    mode: ExecuteMode;
    action: string;
    args?: JsonRecord;
    verifyPolicy?: "off" | "on_critical" | "always";
  }): Promise<ExecuteStepResult>;
}

const BRAIN_TOOL_DEFS: JsonRecord[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a shell command via bash.exec.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: {
            type: "number",
            description: "Optional command timeout in milliseconds. For long tasks, increase this value."
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file's content",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["overwrite", "append", "create"] }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Apply edits to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old: { type: "string" },
                new: { type: "string" }
              },
              required: ["old", "new"]
            }
          }
        },
        required: ["path", "edits"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "snapshot",
      description: "Take an accessibility-first snapshot of the current browser tab",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number" },
          mode: { type: "string", enum: ["text", "interactive", "full"] },
          selector: { type: "string" },
          filter: { type: "string", enum: ["interactive", "all"] },
          format: { type: "string", enum: ["compact", "json"] },
          diff: { type: "boolean" },
          maxTokens: { type: "number" },
          depth: { type: "number" },
          noAnimations: { type: "boolean" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_action",
      description: "Perform a browser action (click, type, fill, press, scroll, select, navigate)",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number" },
          kind: { type: "string", enum: ["click", "type", "fill", "press", "scroll", "select", "navigate"] },
          ref: { type: "string" },
          selector: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          url: { type: "string" },
          expect: { type: "object" }
        },
        required: ["kind"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_verify",
      description: "Verify current browser state after action",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number" },
          expect: { type: "object" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "List available browser tabs",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "open_tab",
      description: "Open a new browser tab",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          active: { type: "boolean" }
        },
        required: ["url"]
      }
    }
  }
];

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

function normalizeErrorCode(code: unknown): string {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function isRetryableToolErrorCode(code: string): boolean {
  return ["E_BUSY", "E_TIMEOUT", "E_CLIENT_TIMEOUT", "E_BRIDGE_DISCONNECTED"].includes(normalizeErrorCode(code));
}

function shouldAutoRetryToolErrorCode(code: string): boolean {
  return ["E_BUSY", "E_CLIENT_TIMEOUT", "E_BRIDGE_DISCONNECTED"].includes(normalizeErrorCode(code));
}

function computeToolRetryDelayMs(attempt: number): number {
  const next = TOOL_AUTO_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(TOOL_AUTO_RETRY_CAP_DELAY_MS, next);
}

function buildToolRetryHint(toolName: string, errorCode: string): string {
  const normalized = normalizeErrorCode(errorCode);
  if (toolName === "bash" && normalized === "E_TIMEOUT") {
    return "Increase bash.timeoutMs and retry the same command.";
  }
  if (normalized === "E_BUSY") {
    return "Bridge is busy, retry after a short delay.";
  }
  if (normalized === "E_CLIENT_TIMEOUT" || normalized === "E_BRIDGE_DISCONNECTED") {
    return "Bridge connection was unstable; retry this tool call.";
  }
  return "Retry only when the failure is transient.";
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

function normalizeSessionTitle(value: unknown, fallback = ""): string {
  const compact = String(value || "")
    .replace(/[`*_>#\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= SESSION_TITLE_MAX) return compact;
  return `${compact.slice(0, SESSION_TITLE_MAX)}…`;
}

function deriveSessionTitle(entries: SessionEntry[]): string {
  const messages = entries.filter((entry) => entry.type === "message");
  const firstUser = messages.find((entry) => entry.role === "user" && String(entry.text || "").trim());
  const firstAssistant = messages.find((entry) => entry.role === "assistant" && String(entry.text || "").trim());

  const candidates = [firstUser?.text, firstAssistant?.text]
    .map((item) => String(item || ""))
    .map((item) => item.split("\n").find((line) => String(line || "").trim()) || item)
    .map((item) => item.replace(/^(请(你)?(帮我)?|帮我|请|麻烦你)\s*/u, ""))
    .map((item) => normalizeSessionTitle(item, ""))
    .filter((item) => item.length >= SESSION_TITLE_MIN);

  return candidates[0] || "";
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
  const retryable = result.retryable === true || isRetryableToolErrorCode(errorCode);
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
  return ["Shared tabs context (user-selected):", ...lines, "Use this context directly before deciding whether to call list_tabs/open_tab."].join("\n");
}

function buildLlmMessagesFromContext(meta: SessionMeta | null, contextMessages: Array<{ role: string; content: string }>): JsonRecord[] {
  const out: JsonRecord[] = [];
  out.push({
    role: "system",
    content: [
      "Tool retry policy:",
      "1) For transient tool errors (retryable=true), retry the same goal with adjusted parameters.",
      "2) bash supports optional timeoutMs (milliseconds). Increase timeoutMs when timeout-related failures happen.",
      "3) For non-retryable errors, stop retrying and explain the blocker clearly."
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
    retryable: out.retryable === true || defaultRetryable || isRetryableToolErrorCode(errorCode),
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
    bridgeInvokeTimeoutMs: normalizeIntInRange(raw.bridgeInvokeTimeoutMs, DEFAULT_BASH_TIMEOUT_MS, 1_000, MAX_BASH_TIMEOUT_MS),
    llmTimeoutMs: normalizeIntInRange(raw.llmTimeoutMs, DEFAULT_LLM_TIMEOUT_MS, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS),
    llmRetryMaxAttempts: normalizeIntInRange(raw.llmRetryMaxAttempts, MAX_LLM_RETRIES, 0, 6),
    devAutoReload: raw.devAutoReload !== false,
    devReloadIntervalMs: Number(raw.devReloadIntervalMs || 1500)
  };
}

async function refreshSessionTitleAuto(orchestrator: BrainOrchestrator, sessionId: string): Promise<void> {
  const meta = await orchestrator.sessions.getMeta(sessionId);
  if (!meta) return;
  const currentTitle = normalizeSessionTitle(meta.header.title, "");
  if (currentTitle) return;

  const entries = await orchestrator.sessions.getEntries(sessionId);
  const derived = normalizeSessionTitle(deriveSessionTitle(entries), "");
  if (!derived) return;

  const nextMeta: SessionMeta = {
    ...meta,
    header: {
      ...meta.header,
      title: derived
    },
    updatedAt: nowIso()
  };
  await writeSessionMeta(sessionId, nextMeta);
  orchestrator.events.emit("session_title_auto_updated", sessionId, { title: derived });
}

export function createRuntimeLoopController(orchestrator: BrainOrchestrator, infra: RuntimeInfraHandler): RuntimeLoopController {
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

  async function executeStep(input: {
    sessionId: string;
    mode: ExecuteMode;
    action: string;
    args?: JsonRecord;
    verifyPolicy?: "off" | "on_critical" | "always";
  }): Promise<ExecuteStepResult> {
    const sessionId = String(input.sessionId || "").trim();
    const normalizedMode = ["script", "cdp", "bridge"].includes(String(input.mode || "").trim())
      ? (String(input.mode || "").trim() as ExecuteMode)
      : ("" as ExecuteMode);
    const normalizedAction = String(input.action || "").trim();
    const payload = toRecord(input.args);
    const actionPayload = toRecord(payload.action) && Object.keys(toRecord(payload.action)).length > 0 ? toRecord(payload.action) : payload;
    const tabId = parsePositiveInt(payload.tabId || actionPayload.tabId);

    if (!normalizedMode) {
      return { ok: false, modeUsed: "cdp", verified: false, error: "mode 必须是 script/cdp/bridge" };
    }
    if (!normalizedAction) {
      return { ok: false, modeUsed: normalizedMode, verified: false, error: "action 不能为空" };
    }

    orchestrator.events.emit("step_execute", sessionId, {
      mode: normalizedMode,
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

      if (actionRequiresLease(kind)) {
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

    let modeUsed: ExecuteMode = normalizedMode;
    let fallbackFrom: ExecuteMode | undefined;
    let data: unknown;
    let preObserve: unknown = null;
    const verifyEnabled = shouldVerifyStep(String(actionPayload.kind || normalizedAction), input.verifyPolicy);

    if (verifyEnabled && tabId && normalizedMode !== "bridge" && normalizedAction !== "verify" && normalizedAction !== "cdp.verify") {
      preObserve = await callInfra(infra, {
        type: "cdp.observe",
        tabId
      }).catch(() => null);
    }

    try {
      data = await runMode(normalizedMode);
    } catch (error) {
      const runtimeError = asRuntimeErrorWithMeta(error);
      if (normalizedMode !== "script") {
        const result: ExecuteStepResult = {
          ok: false,
          modeUsed,
          verified: false,
          error: runtimeError.message,
          errorCode: normalizeErrorCode(runtimeError.code),
          errorDetails: runtimeError.details,
          retryable: runtimeError.retryable
        };
        orchestrator.events.emit("step_execute_result", sessionId, {
          ok: result.ok,
          modeUsed: result.modeUsed,
          verifyReason: result.verifyReason || "",
          verified: result.verified,
          error: result.error || "",
          errorCode: result.errorCode || "",
          retryable: result.retryable === true
        });
        return result;
      }

      fallbackFrom = "script";
      modeUsed = "cdp";
      try {
        data = await runMode("cdp");
      } catch (fallbackError) {
        const runtimeFallbackError = asRuntimeErrorWithMeta(fallbackError);
        const result: ExecuteStepResult = {
          ok: false,
          modeUsed,
          fallbackFrom,
          verified: false,
          error: runtimeFallbackError.message,
          errorCode: normalizeErrorCode(runtimeFallbackError.code),
          errorDetails: runtimeFallbackError.details,
          retryable: runtimeFallbackError.retryable
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
      fallbackFrom,
      verified,
      verifyReason,
      data
    };
    orchestrator.events.emit("step_execute_result", sessionId, {
      ok: result.ok,
      modeUsed: result.modeUsed,
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
    autoRetryMax = TOOL_AUTO_RETRY_MAX
  ): Promise<JsonRecord> {
    const totalAttempts = Math.max(1, autoRetryMax + 1);
    let lastFailure: ExecuteStepResult | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const invoke = await executeStep({
        sessionId,
        mode: "bridge",
        action: "invoke",
        args: {
          frame
        }
      });
      if (invoke.ok) {
        return buildToolResponseEnvelope("invoke", invoke.data, {
          attempt,
          autoRetried: attempt > 1
        });
      }

      lastFailure = invoke;
      const code = normalizeErrorCode(invoke.errorCode);
      const canAutoRetry = attempt < totalAttempts && shouldAutoRetryToolErrorCode(code);
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
      retryable: failure.retryable === true || isRetryableToolErrorCode(errorCode),
      retryHint: buildToolRetryHint(toolName, errorCode),
      details: failure.errorDetails || null
    };
  }

  async function executeToolCall(sessionId: string, toolCall: ToolCallItem): Promise<JsonRecord> {
    const name = String(toolCall.function.name || "").trim();
    const argsRaw = String(toolCall.function.arguments || "").trim();
    let args: JsonRecord = {};
    if (argsRaw) {
      try {
        args = toRecord(JSON.parse(argsRaw));
      } catch (error) {
        return { error: `参数解析失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    switch (name) {
      case "bash": {
        const command = String(args.command || "").trim();
        if (!command) return { error: "bash 需要 command" };
        const timeoutMs =
          args.timeoutMs == null
            ? undefined
            : normalizeIntInRange(args.timeoutMs, DEFAULT_BASH_TIMEOUT_MS, MIN_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
        return await invokeBridgeFrameWithRetry(sessionId, "bash", {
          tool: "bash",
          args: {
            cmdId: "bash.exec",
            args: [command],
            ...(timeoutMs == null ? {} : { timeoutMs })
          }
        });
      }
      case "read_file": {
        const path = String(args.path || "").trim();
        if (!path) return { error: "read_file 需要 path" };
        const invokeArgs: JsonRecord = { path };
        if (args.offset != null) invokeArgs.offset = args.offset;
        if (args.limit != null) invokeArgs.limit = args.limit;
        return await invokeBridgeFrameWithRetry(sessionId, "read_file", {
          tool: "read",
          args: invokeArgs
        });
      }
      case "write_file": {
        const path = String(args.path || "").trim();
        if (!path) return { error: "write_file 需要 path" };
        return await invokeBridgeFrameWithRetry(sessionId, "write_file", {
          tool: "write",
          args: {
            path,
            content: String(args.content || ""),
            mode: String(args.mode || "overwrite")
          }
        });
      }
      case "edit_file": {
        const path = String(args.path || "").trim();
        if (!path) return { error: "edit_file 需要 path" };
        return await invokeBridgeFrameWithRetry(sessionId, "edit_file", {
          tool: "edit",
          args: {
            path,
            edits: Array.isArray(args.edits) ? args.edits : []
          }
        });
      }
      case "list_tabs": {
        const tabs = await queryAllTabsForRuntime();
        const activeTabId = await getActiveTabIdForRuntime();
        return buildToolResponseEnvelope("tabs", {
          count: tabs.length,
          activeTabId,
          tabs
        });
      }
      case "open_tab": {
        const rawUrl = String(args.url || "").trim();
        if (!rawUrl) return { error: "open_tab 需要 url" };
        const created = await chrome.tabs.create({
          url: rawUrl,
          active: args.active !== false
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
      case "snapshot": {
        const tabId = parsePositiveInt(args.tabId) || (await getActiveTabIdForRuntime());
        if (!tabId) {
          return {
            error: "snapshot 需要 tabId，当前无可用 tab",
            errorCode: "E_NO_TAB",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: "Call list_tabs and then retry snapshot with a valid tabId."
          };
        }
        const out = await executeStep({
          sessionId,
          mode: "cdp",
          action: "snapshot",
          args: {
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
        return buildToolResponseEnvelope("snapshot", out.data);
      }
      case "browser_action": {
        const tabId = parsePositiveInt(args.tabId) || (await getActiveTabIdForRuntime());
        if (!tabId) {
          return {
            error: "browser_action 需要 tabId，当前无可用 tab",
            errorCode: "E_NO_TAB",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: "Call list_tabs and retry browser_action with a valid tabId."
          };
        }
        const kind = String(args.kind || "");
        const out = await executeStep({
          sessionId,
          mode: "cdp",
          action: "action",
          args: {
            tabId,
            action: {
              kind,
              ref: args.ref,
              selector: args.selector,
              key: args.key || (kind === "press" ? args.value : undefined),
              value: args.value,
              url: args.url || (kind === "navigate" ? args.value : undefined),
              expect: args.expect
            },
            expect: args.expect
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
        const explicitExpect = normalizeVerifyExpect(args.expect || null);
        const hardFail = !!explicitExpect || kind === "navigate";
        if (!out.verified && hardFail) {
          return {
            error: "browser_action 执行成功但未通过验证",
            errorCode: "E_VERIFY_FAILED",
            errorReason: "failed_verify",
            retryable: true,
            retryHint: "Adjust action args/expect and retry the browser action.",
            details: {
              verifyReason: out.verifyReason,
              data: out.data
            }
          };
        }
        return buildToolResponseEnvelope("cdp_action", out.data, {
          verifyReason: out.verifyReason,
          verified: out.verified
        });
      }
      case "browser_verify": {
        const tabId = parsePositiveInt(args.tabId) || (await getActiveTabIdForRuntime());
        if (!tabId) {
          return {
            error: "browser_verify 需要 tabId，当前无可用 tab",
            errorCode: "E_NO_TAB",
            errorReason: "failed_execute",
            retryable: true,
            retryHint: "Call list_tabs and retry browser_verify with a valid tabId."
          };
        }
        const out = await executeStep({
          sessionId,
          mode: "cdp",
          action: "verify",
          args: {
            tabId,
            action: {
              expect: normalizeVerifyExpect(args.expect || args) || {}
            }
          },
          verifyPolicy: "always"
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
        if (!out.verified) {
          return {
            error: "browser_verify 未通过",
            errorCode: "E_VERIFY_FAILED",
            errorReason: "failed_verify",
            retryable: true,
            retryHint: "Refine expect conditions and re-run browser_verify.",
            details: out.data
          };
        }
        return buildToolResponseEnvelope("cdp", out.data);
      }
      default:
        return { error: `未知工具: ${name}` };
    }
  }

  async function requestLlmWithRetry(input: LlmRequestInput): Promise<JsonRecord> {
    const { sessionId, llmBase, llmKey, llmModel, llmTimeoutMs, step, messages } = input;
    let lastError: unknown = null;
    const maxAttempts = Math.max(0, Number(orchestrator.getRunState(sessionId).retry.maxAttempts || MAX_LLM_RETRIES));
    const totalAttempts = maxAttempts + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort("llm-timeout"), llmTimeoutMs);
      let status = 0;
      let ok = false;
      let rawBody = "";
      let contentType = "";
      try {
        const payload: JsonRecord = {
          model: llmModel,
          messages,
          tools: BRAIN_TOOL_DEFS,
          tool_choice: "auto",
          temperature: 0.2,
          stream: true
        };
        const url = `${llmBase.replace(/\/$/, "")}/chat/completions`;

        orchestrator.events.emit("llm.request", sessionId, {
          step,
          url,
          model: llmModel,
          messageCount: payload.messages && Array.isArray(payload.messages) ? payload.messages.length : 0,
          payload
        });

        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${llmKey}`
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal
        });
        status = resp.status;
        ok = resp.ok;
        contentType = String(resp.headers.get("content-type") || "");

        if (!ok) {
          rawBody = await resp.text();
          orchestrator.events.emit("llm.response.raw", sessionId, {
            step,
            attempt,
            status,
            ok,
            body: clipText(rawBody)
          });
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

        orchestrator.events.emit("llm.response.raw", sessionId, {
          step,
          attempt,
          status,
          ok,
          body: clipText(rawBody)
        });

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
        const err = error as Error & { status?: number };
        const statusCode = Number(err?.status || status || 0);
        const retryable = isRetryableLlmStatus(statusCode) || /timeout|network|temporar|unavailable|rate limit/i.test(String(err?.message || ""));
        const canRetry = retryable && attempt <= maxAttempts;
        if (!canRetry) {
          const state = orchestrator.getRunState(sessionId);
          if (state.retry.active) {
            orchestrator.events.emit("auto_retry_end", sessionId, {
              success: false,
              attempt: state.retry.attempt,
              maxAttempts: state.retry.maxAttempts,
              finalError: err instanceof Error ? err.message : String(err)
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
          reason: err instanceof Error ? err.message : String(err)
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
    orchestrator.updateRetryState(sessionId, {
      maxAttempts: llmRetryMaxAttempts
    });

    orchestrator.events.emit("loop_start", sessionId, {
      prompt: clipText(prompt, 3000)
    });

    if (!llmBase || !llmKey) {
      const text = "当前未配置可用 LLM（llmApiBase/llmApiKey），已记录你的输入。";
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
        status: "done",
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
        const message = await requestLlmWithRetry({
          sessionId,
          llmBase,
          llmKey,
          llmModel,
          llmTimeoutMs,
          step: llmStep,
          messages
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
        await refreshSessionTitleAuto(orchestrator, sessionId);
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
      } else {
        delete metadata.sharedTabs;
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
      resolvedCount: sharedTabs.length
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

    if (Array.isArray(input.tabIds)) {
      await applySharedTabs(sessionId, input.tabIds);
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
    executeStep
  };
}
