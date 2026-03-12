import {
  CURSOR_HELP_REWRITE_STRATEGY,
  CURSOR_HELP_RUNTIME_VERSION
} from "./cursor-help-runtime-meta";

type JsonRecord = Record<string, unknown>;
export type CursorHelpRewriteStrategy = "system_message" | "user_prefix" | "system_message+user_prefix";

export interface CursorHelpParsedSseEvent {
  kind: "delta" | "done" | "error" | "ignore";
  text?: string;
  error?: string;
}

export type CursorHelpTransportEventType =
  | "request_started"
  | "sse_line"
  | "stream_end"
  | "http_error"
  | "invalid_response"
  | "network_error";

export interface CursorHelpExecutionPayload {
  requestId: string;
  sessionId: string;
  compiledPrompt: string;
  latestUserPrompt: string;
  requestedModel: string;
}

export interface CursorHelpSenderInspect {
  pageHookReady: boolean;
  fetchHookReady: boolean;
  senderReady: boolean;
  canExecute: boolean;
  selectedModel?: string;
  availableModels?: string[];
  senderKind?: string;
  lastSenderError?: string;
  pageRuntimeVersion?: string;
  contentRuntimeVersion?: string;
  runtimeExpectedVersion?: string;
  rewriteStrategy?: string;
  runtimeMismatch?: boolean;
  runtimeMismatchReason?: string;
}

export interface CursorHelpRewritePlan {
  requestId: string;
  compiledPrompt: string;
  latestUserPrompt: string;
  requestedModel: string;
  detectedModel?: string;
  rewriteStrategy?: string;
}

export interface CursorHelpNativeEnvelope {
  body: JsonRecord;
  sessionKey: string;
  rewritten: boolean;
  rewriteDebug: CursorHelpRewriteDebug;
}

export interface CursorHelpTargetMessagePointer {
  existingText: string;
  kind: "message_part_text" | "message_content_string" | "message_content_part_text" | "input";
  path: string[];
}

export interface CursorHelpRewriteDebug {
  runtimeVersion: string;
  rewriteStrategy: string;
  targetMessageIndex: number | null;
  targetKind: CursorHelpTargetMessagePointer["kind"] | "none";
  systemMessageInjected: boolean;
  strippedNativeControlMessageCount: number;
  userPromptInjected: boolean;
  compiledPromptHash: string;
  compiledPromptLength: number;
  originalTargetHash: string | null;
  originalTargetLength: number;
  rewrittenTargetHash: string | null;
  rewrittenTargetLength: number;
}

export const CURSOR_HELP_PRIMARY_REQUEST_PATH = "/api/chat";
export const CURSOR_HELP_REQUEST_PATHS = [
  "/api/chat",
  "/chat/completions",
  "/v1/chat/completions"
] as const;
export const CURSOR_HELP_PROMPT_START_PREFIX = "<!-- BBL_PROMPT_START:";
export const CURSOR_HELP_PROMPT_END_PREFIX = "<!-- BBL_PROMPT_END:";
export const CURSOR_HELP_SYSTEM_PROMPT_START_PREFIX = "<!-- BBL_SYSTEM_PROMPT_START:";
export const CURSOR_HELP_SYSTEM_PROMPT_END_PREFIX = "<!-- BBL_SYSTEM_PROMPT_END:";

const MODEL_ALIASES: Array<{ match: RegExp; apiModel: string }> = [
  { match: /anthropic\/claude-sonnet-4\.6|claude-sonnet-4\.6|sonnet 4\.6/i, apiModel: "anthropic/claude-sonnet-4.6" },
  { match: /anthropic\/claude-sonnet-4|claude-sonnet-4|sonnet 4/i, apiModel: "anthropic/claude-sonnet-4" },
  { match: /anthropic\/claude-opus-4\.1|claude-opus-4\.1|opus 4\.1/i, apiModel: "anthropic/claude-opus-4.1" },
  { match: /anthropic\/claude-opus-4|claude-opus-4|opus 4/i, apiModel: "anthropic/claude-opus-4" },
  { match: /google\/gemini-2\.5-pro|gemini-2\.5-pro|gemini 2\.5 pro/i, apiModel: "google/gemini-2.5-pro" },
  { match: /google\/gemini-2\.5-flash|gemini-2\.5-flash|gemini 2\.5 flash/i, apiModel: "google/gemini-2.5-flash" },
  { match: /openai\/gpt-5|gpt-5/i, apiModel: "openai/gpt-5" },
  { match: /openai\/gpt-4\.1|gpt-4\.1/i, apiModel: "openai/gpt-4.1" },
  { match: /openai\/o3|o3/i, apiModel: "openai/o3" },
  { match: /openai\/o1|o1/i, apiModel: "openai/o1" }
];

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function cloneJsonRecord(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(toRecord(value))) as JsonRecord;
}

function normalizeModelText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function normalizeCursorHelpRewriteStrategy(
  raw: unknown,
  fallback: CursorHelpRewriteStrategy = CURSOR_HELP_REWRITE_STRATEGY as CursorHelpRewriteStrategy
): CursorHelpRewriteStrategy {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "system_message") return "system_message";
  if (normalized === "user_prefix") return "user_prefix";
  if (normalized === "system_message+user_prefix") return "system_message+user_prefix";
  return fallback;
}

function buildPromptEnvelope(compiledPrompt: string, requestId: string): string {
  const normalizedRequestId = String(requestId || "").trim() || "unknown";
  return [
    `${CURSOR_HELP_PROMPT_START_PREFIX}${normalizedRequestId} -->`,
    String(compiledPrompt || ""),
    `${CURSOR_HELP_PROMPT_END_PREFIX}${normalizedRequestId} -->`
  ].join("\n");
}

function buildSystemPromptEnvelope(compiledPrompt: string, requestId: string): string {
  const normalizedRequestId = String(requestId || "").trim() || "unknown";
  return [
    `${CURSOR_HELP_SYSTEM_PROMPT_START_PREFIX}${normalizedRequestId} -->`,
    String(compiledPrompt || ""),
    `${CURSOR_HELP_SYSTEM_PROMPT_END_PREFIX}${normalizedRequestId} -->`
  ].join("\n");
}

function readPathValue(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as JsonRecord)[segment];
  }
  return current;
}

function writePathValue(root: unknown, path: string[], value: unknown): boolean {
  if (path.length <= 0 || root === null || root === undefined) return false;
  let current: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      if (!Number.isInteger(arrayIndex)) return false;
      current = current[arrayIndex];
      continue;
    }
    if (typeof current !== "object" || current === null) return false;
    current = (current as JsonRecord)[segment];
  }
  const last = path[path.length - 1];
  if (Array.isArray(current)) {
    const arrayIndex = Number(last);
    if (!Number.isInteger(arrayIndex)) return false;
    current[arrayIndex] = value;
    return true;
  }
  if (typeof current !== "object" || current === null) return false;
  (current as JsonRecord)[last] = value;
  return true;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  const text = String(input || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getTargetMessageIndex(pointer: CursorHelpTargetMessagePointer | null): number | null {
  if (!pointer) return null;
  if (pointer.path[0] !== "messages") return null;
  const index = Number(pointer.path[1]);
  return Number.isInteger(index) ? index : null;
}

export function resolveCursorHelpApiModel(requestedModel: string, detectedModel = ""): string {
  const candidates = [requestedModel, detectedModel];
  for (const candidate of candidates) {
    const normalized = normalizeModelText(candidate);
    if (!normalized || normalized.toLowerCase() === "auto") continue;
    for (const alias of MODEL_ALIASES) {
      if (alias.match.test(normalized)) return alias.apiModel;
    }
    if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(normalized)) {
      return normalized;
    }
  }
  return "anthropic/claude-sonnet-4.6";
}

export function isCursorHelpTargetRequestUrl(url: string): boolean {
  const normalized = String(url || "").trim();
  if (!normalized) return false;
  try {
    const pathname = new URL(normalized, "https://cursor.com").pathname;
    return CURSOR_HELP_REQUEST_PATHS.includes(pathname as (typeof CURSOR_HELP_REQUEST_PATHS)[number]);
  } catch {
    return false;
  }
}

export function injectCompiledPromptIdempotent(sourceText: string, compiledPrompt: string, requestId: string): string {
  const envelope = buildPromptEnvelope(compiledPrompt, requestId);
  const normalizedSource = String(sourceText || "");
  const hasPromptEnvelope =
    normalizedSource.includes(CURSOR_HELP_PROMPT_START_PREFIX) && normalizedSource.includes(CURSOR_HELP_PROMPT_END_PREFIX);
  if (!hasPromptEnvelope) return envelope;
  return normalizedSource.replace(
    /<!-- BBL_PROMPT_START:[^>]+ -->[\s\S]*?<!-- BBL_PROMPT_END:[^>]+ -->/g,
    envelope
  );
}

export function extractCursorHelpTargetMessagePointer(rawBody: unknown): CursorHelpTargetMessagePointer | null {
  const body = toRecord(rawBody);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = toRecord(messages[messageIndex]);
    const role = String(message.role || "").trim().toLowerCase();
    if (role && role !== "user") continue;

    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = toRecord(parts[partIndex]);
      if (typeof part.text === "string") {
        return {
          existingText: String(part.text || ""),
          kind: "message_part_text",
          path: ["messages", String(messageIndex), "parts", String(partIndex), "text"]
        };
      }
    }

    if (typeof message.content === "string") {
      return {
        existingText: String(message.content || ""),
        kind: "message_content_string",
        path: ["messages", String(messageIndex), "content"]
      };
    }

    const contentParts = Array.isArray(message.content) ? message.content : [];
    for (let partIndex = 0; partIndex < contentParts.length; partIndex += 1) {
      const part = toRecord(contentParts[partIndex]);
      const textValue =
        typeof part.text === "string"
          ? part.text
          : typeof part.content === "string"
            ? part.content
            : typeof part.input_text === "string"
              ? part.input_text
              : null;
      if (typeof textValue === "string") {
        const field = typeof part.text === "string" ? "text" : typeof part.content === "string" ? "content" : "input_text";
        return {
          existingText: textValue,
          kind: "message_content_part_text",
          path: ["messages", String(messageIndex), "content", String(partIndex), field]
        };
      }
    }
  }

  if (typeof body.input === "string") {
    return {
      existingText: String(body.input || ""),
      kind: "input",
      path: ["input"]
    };
  }

  return null;
}

function getMessageText(rawMessage: unknown): string {
  const message = toRecord(rawMessage);
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    const row = toRecord(part);
    if (typeof row.text === "string") return row.text;
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  const contentParts = Array.isArray(message.content) ? message.content : [];
  for (const part of contentParts) {
    const row = toRecord(part);
    if (typeof row.text === "string") return row.text;
    if (typeof row.content === "string") return row.content;
    if (typeof row.input_text === "string") return row.input_text;
  }

  return "";
}

function getMessageRole(rawMessage: unknown): string {
  return String(toRecord(rawMessage).role || "").trim().toLowerCase();
}

function isInjectedSystemMessage(rawMessage: unknown): boolean {
  const message = toRecord(rawMessage);
  const role = getMessageRole(message);
  if (role !== "system") return false;
  const text = getMessageText(message);
  return (
    text.includes(CURSOR_HELP_SYSTEM_PROMPT_START_PREFIX) &&
    text.includes(CURSOR_HELP_SYSTEM_PROMPT_END_PREFIX)
  );
}

function isNativeControlMessage(rawMessage: unknown): boolean {
  const role = getMessageRole(rawMessage);
  if (role !== "system" && role !== "developer") return false;
  return !isInjectedSystemMessage(rawMessage);
}

function buildInjectedSystemMessage(body: JsonRecord, compiledPrompt: string, requestId: string): JsonRecord {
  const envelope = buildSystemPromptEnvelope(compiledPrompt, requestId);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const rawMessage of messages) {
    const message = toRecord(rawMessage);
    if (Array.isArray(message.parts)) {
      return {
        role: "system",
        parts: [
          {
            type: "text",
            text: envelope
          }
        ]
      };
    }
    if (typeof message.content === "string") {
      return {
        role: "system",
        content: envelope
      };
    }
    if (Array.isArray(message.content)) {
      return {
        role: "system",
        content: [
          {
            type: "text",
            text: envelope
          }
        ]
      };
    }
  }

  return {
    role: "system",
    content: envelope
  };
}

function upsertInjectedSystemMessage(
  body: JsonRecord,
  compiledPrompt: string,
  requestId: string
): { injected: boolean; strippedNativeControlMessageCount: number } {
  if (!Array.isArray(body.messages)) {
    return {
      injected: false,
      strippedNativeControlMessageCount: 0
    };
  }
  let strippedNativeControlMessageCount = 0;
  const messages = body.messages.filter((message) => {
    if (isInjectedSystemMessage(message)) return false;
    if (isNativeControlMessage(message)) {
      strippedNativeControlMessageCount += 1;
      return false;
    }
    return true;
  });
  const targetPointer = extractCursorHelpTargetMessagePointer({
    ...body,
    messages
  });
  const targetIndex = getTargetMessageIndex(targetPointer);
  const fallbackInsertIndex = messages.reduce((insertAt, rawMessage, index) => {
    const role = String(toRecord(rawMessage).role || "").trim().toLowerCase();
    if (role === "system" || role === "developer") return index + 1;
    return insertAt;
  }, 0);
  const insertIndex =
    targetIndex !== null && targetIndex >= 0 && targetIndex <= messages.length ? targetIndex : fallbackInsertIndex;
  messages.splice(insertIndex, 0, buildInjectedSystemMessage(body, compiledPrompt, requestId));
  body.messages = messages;
  return {
    injected: true,
    strippedNativeControlMessageCount
  };
}

export function deriveCursorHelpSessionKey(rawBody: unknown, requestUrl = ""): string {
  const body = toRecord(rawBody);
  const directIdCandidates = [
    body.id,
    body.requestId,
    body.request_id,
    body.conversationId,
    body.conversation_id,
    body.sessionId,
    body.session_id
  ];
  for (const candidate of directIdCandidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return `cursor-help:${normalized}`;
  }

  const pointer = extractCursorHelpTargetMessagePointer(body);
  const messageIdSeed = Array.isArray(body.messages)
    ? Array.from(body.messages)
        .reverse()
        .map((item) => String(toRecord(item).id || "").trim())
        .find(Boolean) || ""
    : "";
  const urlPath = (() => {
    try {
      return new URL(String(requestUrl || ""), "https://cursor.com").pathname;
    } catch {
      return String(requestUrl || "");
    }
  })();
  const seed = [urlPath, messageIdSeed, pointer?.existingText.slice(0, 160) || ""].join("|");
  return `cursor-help:derived:${stableHash(seed)}`;
}

export function rewriteCursorHelpNativeRequestBody(rawBody: unknown, rewritePlan: CursorHelpRewritePlan): CursorHelpNativeEnvelope {
  const body = cloneJsonRecord(rawBody);
  const rewriteStrategy = normalizeCursorHelpRewriteStrategy(rewritePlan.rewriteStrategy);
  const injectSystemMessage = rewriteStrategy === "system_message" || rewriteStrategy === "system_message+user_prefix";
  const injectUserPrefix = rewriteStrategy === "user_prefix" || rewriteStrategy === "system_message+user_prefix";
  const systemRewrite = injectSystemMessage
    ? upsertInjectedSystemMessage(body, rewritePlan.compiledPrompt, rewritePlan.requestId)
    : {
        injected: false,
        strippedNativeControlMessageCount: 0
      };
  const systemMessageInjected = systemRewrite.injected;
  let rewritten = systemMessageInjected || systemRewrite.strippedNativeControlMessageCount > 0;
  const pointer = extractCursorHelpTargetMessagePointer(body);
  let rewrittenTargetText = pointer?.existingText || "";
  let userPromptInjected = false;
  if (pointer && injectUserPrefix) {
    const nextText = injectCompiledPromptIdempotent(pointer.existingText, rewritePlan.compiledPrompt, rewritePlan.requestId);
    if (nextText !== pointer.existingText) {
      writePathValue(body, pointer.path, nextText);
      rewritten = true;
      userPromptInjected = true;
      rewrittenTargetText = nextText;
    }
  }

  if (typeof body.model === "string" && String(rewritePlan.requestedModel || "").trim().toLowerCase() !== "auto") {
    body.model = resolveCursorHelpApiModel(rewritePlan.requestedModel, rewritePlan.detectedModel || String(body.model || ""));
  }

  const sessionKey = deriveCursorHelpSessionKey(body);

  return {
    body,
    sessionKey,
    rewritten,
    rewriteDebug: {
      runtimeVersion: CURSOR_HELP_RUNTIME_VERSION,
      rewriteStrategy,
      targetMessageIndex: getTargetMessageIndex(pointer),
      targetKind: pointer?.kind || "none",
      systemMessageInjected,
      strippedNativeControlMessageCount: systemRewrite.strippedNativeControlMessageCount,
      userPromptInjected,
      compiledPromptHash: stableHash(rewritePlan.compiledPrompt),
      compiledPromptLength: String(rewritePlan.compiledPrompt || "").length,
      originalTargetHash: pointer ? stableHash(pointer.existingText) : null,
      originalTargetLength: pointer ? pointer.existingText.length : 0,
      rewrittenTargetHash: pointer ? stableHash(rewrittenTargetText) : null,
      rewrittenTargetLength: pointer ? rewrittenTargetText.length : 0
    }
  };
}

export function classifyCursorHelpHttpError(status: number, bodyText: string): string {
  const detail = String(bodyText || "").trim();
  const suffix = detail ? ` ${detail}` : "";
  if (status === 401) return `Cursor Help 未登录或登录态失效。请先在 cursor.com 登录。${suffix}`.trim();
  if (status === 403) return `Cursor Help 当前账号无权访问该请求。${suffix}`.trim();
  if (status === 404) return `Cursor Help /api/chat 不可用。${suffix}`.trim();
  if (status === 429) return `Cursor Help 请求过于频繁，已被限流。${suffix}`.trim();
  if (status >= 500) return `Cursor Help 服务暂时异常 (${status})。${suffix}`.trim();
  return detail ? `/api/chat 请求失败: ${status} ${detail}` : `/api/chat 请求失败: ${status}`;
}

export function classifyCursorHelpInvalidResponse(status: number, contentType: string, bodyText = ""): string {
  const normalizedType = String(contentType || "").trim() || "(empty)";
  const detail = String(bodyText || "").trim();
  const suffix = detail ? ` ${detail}` : "";
  return `Cursor Help 返回非 SSE 响应 (${status}, ${normalizedType})。${suffix}`.trim();
}

export function parseCursorHelpSseLine(line: string): CursorHelpParsedSseEvent {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("data:")) return { kind: "ignore" };
  const payload = trimmed.slice(5).trim();
  if (!payload) return { kind: "ignore" };
  if (payload === "[DONE]") return { kind: "done" };

  let parsed: JsonRecord = {};
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "ignore" };
  }

  if (parsed.type === "text-delta" && typeof parsed.delta === "string") {
    return {
      kind: "delta",
      text: parsed.delta
    };
  }
  if (parsed.type === "finish") {
    return { kind: "done" };
  }
  if (parsed.type === "error") {
    return {
      kind: "error",
      error: String(parsed.errorText || parsed.message || "Cursor Help SSE error")
    };
  }
  return { kind: "ignore" };
}
