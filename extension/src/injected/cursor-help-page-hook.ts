import {
  locateCursorHelpNativeSender,
  resolveNativeSenderInputText,
  type NativeSender
} from "./cursor-help-native-sender";

const PAGE_SOURCE = "bbl-cursor-help-page";
const CONTENT_SOURCE = "bbl-cursor-help-content";
const PAGE_HOOK_READY_ATTR = "data-bbl-cursor-help-page-ready";
const FETCH_HOOK_READY_ATTR = "data-bbl-cursor-help-fetch-ready";
const PAGE_HOOK_INSTALLED_FLAG = "__bblCursorHelpPageHookInstalled";
// Keep injected MAIN-world script self-contained. Do not import shared runtime-meta here.
const CURSOR_HELP_RUNTIME_VERSION = "cursor-help-runtime-2026-03-12-r1";
const CURSOR_HELP_REWRITE_STRATEGY = "system_message+user_prefix";
const CURSOR_HELP_REWRITE_STRATEGY_OVERRIDE_STORAGE_KEY = "__bblCursorHelpRewriteStrategy";
const CURSOR_HELP_PAGE_RUNTIME_VERSION_ATTR = "data-bbl-cursor-help-runtime-version";
const CURSOR_HELP_PAGE_REWRITE_STRATEGY_ATTR = "data-bbl-cursor-help-rewrite-strategy";

type JsonRecord = Record<string, unknown>;
type CursorHelpRewriteStrategy = "system_message" | "user_prefix" | "system_message+user_prefix";
type CursorHelpTransportEventType =
  | "request_started"
  | "sse_line"
  | "stream_end"
  | "http_error"
  | "invalid_response"
  | "network_error";

interface CursorHelpExecutionPayload {
  requestId: string;
  sessionId: string;
  compiledPrompt: string;
  latestUserPrompt: string;
  requestedModel: string;
}

interface CursorHelpSenderInspect {
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

interface CursorHelpRewritePlan {
  requestId: string;
  compiledPrompt: string;
  latestUserPrompt: string;
  requestedModel: string;
  detectedModel?: string;
  rewriteStrategy?: string;
}

interface CursorHelpNativeEnvelope {
  body: JsonRecord;
  sessionKey: string;
  rewritten: boolean;
  rewriteDebug: CursorHelpRewriteDebug;
}

interface CursorHelpTargetMessagePointer {
  existingText: string;
  kind: "message_part_text" | "message_content_string" | "message_content_part_text" | "input";
  path: string[];
}

interface CursorHelpRewriteDebug {
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

interface PendingExecution extends CursorHelpExecutionPayload {
  createdAt: number;
  state: "pending" | "sender_invoked" | "request_started";
  matchedUrl: string | null;
  sessionKey: string | null;
  controller: AbortController | null;
}

const pendingExecutions = new Map<string, PendingExecution>();
let lastSenderError = "";
const CURSOR_HELP_REQUEST_PATHS = [
  "/api/chat",
  "/chat/completions",
  "/v1/chat/completions"
] as const;
const CURSOR_HELP_PROMPT_START_PREFIX = "<!-- BBL_PROMPT_START:";
const CURSOR_HELP_PROMPT_END_PREFIX = "<!-- BBL_PROMPT_END:";
const CURSOR_HELP_SYSTEM_PROMPT_START_PREFIX = "<!-- BBL_SYSTEM_PROMPT_START:";
const CURSOR_HELP_SYSTEM_PROMPT_END_PREFIX = "<!-- BBL_SYSTEM_PROMPT_END:";
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

function normalizeCursorHelpRewriteStrategy(
  raw: unknown,
  fallback: CursorHelpRewriteStrategy = CURSOR_HELP_REWRITE_STRATEGY as CursorHelpRewriteStrategy
): CursorHelpRewriteStrategy {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "system_message") return "system_message";
  if (normalized === "user_prefix") return "user_prefix";
  if (normalized === "system_message+user_prefix") return "system_message+user_prefix";
  return fallback;
}

function resolveCursorHelpRewriteStrategy(): CursorHelpRewriteStrategy {
  try {
    return normalizeCursorHelpRewriteStrategy(localStorage.getItem(CURSOR_HELP_REWRITE_STRATEGY_OVERRIDE_STORAGE_KEY));
  } catch {
    return CURSOR_HELP_REWRITE_STRATEGY as CursorHelpRewriteStrategy;
  }
}

function syncRewriteStrategyAttr(strategy = resolveCursorHelpRewriteStrategy()): void {
  document.documentElement?.setAttribute(CURSOR_HELP_PAGE_REWRITE_STRATEGY_ATTR, strategy);
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

function resolveCursorHelpApiModel(requestedModel: string, detectedModel = ""): string {
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

function isCursorHelpTargetRequestUrl(url: string): boolean {
  const normalized = String(url || "").trim();
  if (!normalized) return false;
  try {
    const pathname = new URL(normalized, "https://cursor.com").pathname;
    return CURSOR_HELP_REQUEST_PATHS.includes(pathname as (typeof CURSOR_HELP_REQUEST_PATHS)[number]);
  } catch {
    return false;
  }
}

function injectCompiledPromptIdempotent(sourceText: string, compiledPrompt: string, requestId: string): string {
  const envelope = buildPromptEnvelope(compiledPrompt, requestId);
  const normalizedSource = String(sourceText || "");
  const strippedSource =
    normalizedSource.includes(CURSOR_HELP_PROMPT_START_PREFIX) && normalizedSource.includes(CURSOR_HELP_PROMPT_END_PREFIX)
      ? normalizedSource
          .replace(/<!-- BBL_PROMPT_START:[^>]+ -->[\s\S]*?<!-- BBL_PROMPT_END:[^>]+ -->\s*/g, "")
          .replace(/^\s+/, "")
      : normalizedSource;
  return strippedSource ? `${envelope}\n\n${strippedSource}` : envelope;
}

function extractCursorHelpTargetMessagePointer(rawBody: unknown): CursorHelpTargetMessagePointer | null {
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

function stripInjectedPromptEnvelopeFromMessage(rawMessage: unknown): boolean {
  const message = toRecord(rawMessage);
  let changed = false;

  const stripText = (text: string): string => {
    if (!text.includes(CURSOR_HELP_PROMPT_START_PREFIX) || !text.includes(CURSOR_HELP_PROMPT_END_PREFIX)) return text;
    const next = text.replace(/<!-- BBL_PROMPT_START:[^>]+ -->[\s\S]*?<!-- BBL_PROMPT_END:[^>]+ -->\s*/g, "").replace(/^\s+/, "");
    if (next !== text) changed = true;
    return next;
  };

  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      const row = toRecord(part);
      if (typeof row.text === "string") {
        row.text = stripText(row.text);
      }
    }
  }

  if (typeof message.content === "string") {
    message.content = stripText(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const row = toRecord(part);
      if (typeof row.text === "string") {
        row.text = stripText(row.text);
      } else if (typeof row.content === "string") {
        row.content = stripText(row.content);
      } else if (typeof row.input_text === "string") {
        row.input_text = stripText(row.input_text);
      }
    }
  }

  return changed;
}

function stripInjectedPromptEnvelopes(body: JsonRecord): number {
  let strippedCount = 0;
  if (Array.isArray(body.messages)) {
    for (const rawMessage of body.messages) {
      if (getMessageRole(rawMessage) !== "user") continue;
      if (stripInjectedPromptEnvelopeFromMessage(rawMessage)) {
        strippedCount += 1;
      }
    }
  }

  if (typeof body.input === "string") {
    const next = body.input.replace(/<!-- BBL_PROMPT_START:[^>]+ -->[\s\S]*?<!-- BBL_PROMPT_END:[^>]+ -->\s*/g, "").replace(/^\s+/, "");
    if (next !== body.input) {
      body.input = next;
      strippedCount += 1;
    }
  }

  return strippedCount;
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

function deriveCursorHelpSessionKey(rawBody: unknown, requestUrl = ""): string {
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

function rewriteCursorHelpNativeRequestBody(rawBody: unknown, rewritePlan: CursorHelpRewritePlan): CursorHelpNativeEnvelope {
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
  const strippedPromptEnvelopeCount = stripInjectedPromptEnvelopes(body);
  let rewritten =
    systemMessageInjected ||
    systemRewrite.strippedNativeControlMessageCount > 0 ||
    strippedPromptEnvelopeCount > 0;
  const pointer = extractCursorHelpTargetMessagePointer(body);
  let rewrittenTargetText = pointer?.existingText || "";
  let userPromptInjected = false;
  if (pointer && injectUserPrefix) {
    const nextText = injectCompiledPromptIdempotent(
      String(rewritePlan.latestUserPrompt || "").trim() || pointer.existingText,
      rewritePlan.compiledPrompt,
      rewritePlan.requestId
    );
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

function classifyCursorHelpInvalidResponse(status: number, contentType: string, bodyText = ""): string {
  const normalizedType = String(contentType || "").trim() || "(empty)";
  const detail = String(bodyText || "").trim();
  const suffix = detail ? ` ${detail}` : "";
  return `Cursor Help 返回非 SSE 响应 (${status}, ${normalizedType})。${suffix}`.trim();
}

function logToContent(step: string, status: "running" | "done" | "failed", detail: string): void {
  window.postMessage(
    {
      source: PAGE_SOURCE,
      type: "PAGE_HOOK_LOG",
      payload: {
        step,
        status,
        detail
      }
    },
    window.location.origin
  );
}

function postPageMessage(type: string, payload: Record<string, unknown>): void {
  window.postMessage(
    {
      source: PAGE_SOURCE,
      type,
      payload
    },
    window.location.origin
  );
}

function emitTransportEvent(
  requestId: string,
  transportType: CursorHelpTransportEventType,
  extra: Record<string, unknown> = {}
): void {
  postPageMessage("WEBCHAT_TRANSPORT_EVENT", {
    requestId,
    transportType,
    ...extra
  });
}

function replyRpc(rpcId: string, payload: Record<string, unknown>): void {
  postPageMessage("WEBCHAT_RPC_RESULT", {
    rpcId,
    ...payload
  });
}

function locateNativeSender(): NativeSender | null {
  const discovery = locateCursorHelpNativeSender(document);
  lastSenderError = discovery.error;
  return discovery.sender;
}

async function waitForNativeSender(timeoutMs = 2_500): Promise<NativeSender | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const sender = locateNativeSender();
    if (sender) return sender;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return locateNativeSender();
}

function inspectSender(): CursorHelpSenderInspect {
  const sender = locateNativeSender();
  const senderReady = Boolean(sender);
  const senderKind = sender?.senderKind;
  const rewriteStrategy = resolveCursorHelpRewriteStrategy();
  syncRewriteStrategyAttr(rewriteStrategy);
  return {
    pageHookReady: true,
    fetchHookReady: document.documentElement?.getAttribute(FETCH_HOOK_READY_ATTR) === "1",
    senderReady,
    canExecute: Boolean(sender && document.documentElement?.getAttribute(FETCH_HOOK_READY_ATTR) === "1"),
    senderKind,
    lastSenderError: senderReady ? "" : lastSenderError,
    pageRuntimeVersion: CURSOR_HELP_RUNTIME_VERSION,
    rewriteStrategy
  };
}

function cleanupExecution(requestId: string): void {
  pendingExecutions.delete(requestId);
}

function findOldestPendingExecution(): PendingExecution | null {
  let selected: PendingExecution | null = null;
  for (const execution of pendingExecutions.values()) {
    if (execution.state === "request_started") continue;
    if (!selected || execution.createdAt < selected.createdAt) {
      selected = execution;
    }
  }
  return selected;
}

function combineSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length <= 0) return undefined;
  const anyFn = (AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return anyFn(activeSignals);
  }

  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => {
        controller.abort((signal as AbortSignal & { reason?: unknown }).reason);
      },
      { once: true }
    );
  }
  return controller.signal;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input, window.location.origin).toString();
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input || "");
}

async function readRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  if (typeof init?.body === "string") {
    return JSON.parse(init.body);
  }
  if (
    init?.body &&
    typeof Blob !== "undefined" &&
    init.body instanceof Blob &&
    init.body.type.toLowerCase().includes("json")
  ) {
    return JSON.parse(await init.body.text());
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    const clone = input.clone();
    const text = await clone.text();
    return text ? JSON.parse(text) : {};
  }
  return {};
}

function buildFetchInit(input: RequestInfo | URL, init: RequestInit | undefined, body: JsonRecord, signal?: AbortSignal): RequestInit {
  const baseRequest = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const headers = new Headers(init?.headers || baseRequest?.headers || {});
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return {
    method: init?.method || baseRequest?.method || "POST",
    headers,
    body: JSON.stringify(body),
    credentials: init?.credentials || baseRequest?.credentials,
    cache: init?.cache || baseRequest?.cache,
    mode: init?.mode || baseRequest?.mode,
    redirect: init?.redirect || baseRequest?.redirect,
    referrer: init?.referrer || baseRequest?.referrer,
    referrerPolicy: init?.referrerPolicy || baseRequest?.referrerPolicy,
    integrity: init?.integrity || baseRequest?.integrity,
    keepalive: init?.keepalive || baseRequest?.keepalive,
    signal
  };
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return (await response.clone().text()).slice(0, 240);
  } catch {
    return "";
  }
}

async function forwardCursorHelpStream(
  stream: ReadableStream<Uint8Array>,
  requestId: string,
  sessionKey: string | null
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak >= 0) {
        const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
        buffer = buffer.slice(lineBreak + 1);
        emitTransportEvent(requestId, "sse_line", {
          line,
          sessionKey: sessionKey || undefined
        });
        lineBreak = buffer.indexOf("\n");
      }
    }

    const tail = buffer + decoder.decode();
    if (tail) {
      for (const line of tail.split(/\r?\n/)) {
        emitTransportEvent(requestId, "sse_line", {
          line,
          sessionKey: sessionKey || undefined
        });
      }
    }
    emitTransportEvent(requestId, "stream_end", {
      sessionKey: sessionKey || undefined
    });
  } catch (error) {
    emitTransportEvent(requestId, "network_error", {
      error: error instanceof Error ? error.message : String(error),
      sessionKey: sessionKey || undefined
    });
  } finally {
    cleanupExecution(requestId);
  }
}

function installFetchHook(): void {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = resolveRequestUrl(input);
    if (!isCursorHelpTargetRequestUrl(requestUrl)) {
      return nativeFetch(input, init);
    }

    const execution = findOldestPendingExecution();
    if (!execution) {
      return nativeFetch(input, init);
    }

    let rewrittenBody: JsonRecord;
    let rewriteDebug: CursorHelpRewriteDebug | null = null;
    const rewriteStrategy = resolveCursorHelpRewriteStrategy();
    syncRewriteStrategyAttr(rewriteStrategy);
    try {
      const rawBody = await readRequestBody(input, init);
      const rewritten = rewriteCursorHelpNativeRequestBody(rawBody, {
        requestId: execution.requestId,
        compiledPrompt: execution.compiledPrompt,
        latestUserPrompt: execution.latestUserPrompt,
        requestedModel: execution.requestedModel,
        detectedModel: "",
        rewriteStrategy
      });
      if (!rewritten.rewritten) {
        throw new Error("Cursor Help 原生请求体无法定位目标消息");
      }
      execution.state = "request_started";
      execution.matchedUrl = requestUrl;
      execution.sessionKey = rewritten.sessionKey;
      rewrittenBody = rewritten.body;
      rewriteDebug = rewritten.rewriteDebug;
    } catch (error) {
      cleanupExecution(execution.requestId);
      const message = error instanceof Error ? error.message : String(error);
      emitTransportEvent(execution.requestId, "network_error", { error: message });
      throw error instanceof Error ? error : new Error(message);
    }

    const controller = new AbortController();
    execution.controller = controller;
    const signal = combineSignals([controller.signal, init?.signal, input instanceof Request ? input.signal : undefined]);
    const nextInit = buildFetchInit(input, init, rewrittenBody, signal);

    emitTransportEvent(execution.requestId, "request_started", {
      url: requestUrl,
      sessionKey: execution.sessionKey || undefined,
      runtimeVersion: CURSOR_HELP_RUNTIME_VERSION,
      rewriteStrategy,
      rewriteDebug: rewriteDebug || undefined
    });
    logToContent("transport.request_started", "done", `${execution.requestId} -> ${requestUrl}`);

    let response: Response;
    try {
      response = await nativeFetch(requestUrl, nextInit);
    } catch (error) {
      cleanupExecution(execution.requestId);
      emitTransportEvent(execution.requestId, "network_error", {
        error: error instanceof Error ? error.message : String(error),
        sessionKey: execution.sessionKey || undefined
      });
      throw error;
    }

    const contentType = String(response.headers.get("content-type") || "").trim();
    if (!response.ok) {
      cleanupExecution(execution.requestId);
      emitTransportEvent(execution.requestId, "http_error", {
        status: response.status,
        contentType,
        bodyText: await readResponseText(response),
        sessionKey: execution.sessionKey || undefined
      });
      return response;
    }

    if (!contentType.toLowerCase().includes("text/event-stream") || !response.body) {
      cleanupExecution(execution.requestId);
      emitTransportEvent(execution.requestId, "invalid_response", {
        status: response.status,
        contentType,
        bodyText: await readResponseText(response),
        sessionKey: execution.sessionKey || undefined
      });
      logToContent(
        "transport.invalid_response",
        "failed",
        classifyCursorHelpInvalidResponse(response.status, contentType)
      );
      return response;
    }

    const [pageStream, transportStream] = response.body.tee();
    void forwardCursorHelpStream(transportStream, execution.requestId, execution.sessionKey);
    return new Response(pageStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };

  document.documentElement?.setAttribute(FETCH_HOOK_READY_ATTR, "1");
  document.documentElement?.setAttribute(CURSOR_HELP_PAGE_RUNTIME_VERSION_ATTR, CURSOR_HELP_RUNTIME_VERSION);
  syncRewriteStrategyAttr();
  logToContent("boot.fetch_hook", "done", "cursor help fetch hook 已安装");
}

async function executeNativeSend(payload: CursorHelpExecutionPayload): Promise<Record<string, unknown>> {
  const sender = await waitForNativeSender();
  if (!sender) {
    return {
      ok: false,
      error: lastSenderError || "内部入口未就绪"
    };
  }

  pendingExecutions.set(payload.requestId, {
    ...payload,
    createdAt: Date.now(),
    state: "pending",
    matchedUrl: null,
    sessionKey: null,
    controller: null
  });

  try {
    const execution = pendingExecutions.get(payload.requestId);
    if (!execution) throw new Error("执行上下文已丢失");
    execution.state = "sender_invoked";
    // Kernel/provider owns the compiled prompt. Page sender only seeds a user-visible
    // message so the real request can be emitted and then rewritten by the fetch hook.
    const senderInputText = resolveNativeSenderInputText(payload.latestUserPrompt, payload.compiledPrompt);
    void Promise.resolve(sender.submit(senderInputText, payload.requestedModel))
      .then(() => {
        const latest = pendingExecutions.get(payload.requestId);
        if (!latest) return;
        logToContent("execute.sender_resolved", "done", `native sender promise resolved requestId=${payload.requestId}`);
      })
      .catch((error) => {
        const latest = pendingExecutions.get(payload.requestId);
        const message = error instanceof Error ? error.message : String(error);
        lastSenderError = message;
        logToContent("execute.sender_rejected", "failed", `native sender promise rejected: ${message}`);
        if (!latest || latest.state === "request_started") {
          return;
        }
        cleanupExecution(payload.requestId);
        emitTransportEvent(payload.requestId, "network_error", {
          error: message
        });
      });
    return {
      ok: true,
      senderKind: sender.senderKind
    };
  } catch (error) {
    cleanupExecution(payload.requestId);
    lastSenderError = error instanceof Error ? error.message : String(error);
    emitTransportEvent(payload.requestId, "network_error", {
      error: lastSenderError
    });
    return {
      ok: false,
      error: lastSenderError
    };
  }
}

function installPageMessageBridge(): void {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CONTENT_SOURCE || !data.type) return;

    if (data.type === "WEBCHAT_EXECUTE") {
      const payload = toRecord(data.payload);
      const rpcId = String(payload.rpcId || "").trim();
      const requestId = String(payload.requestId || "").trim();
      const sessionId = String(payload.sessionId || "").trim() || "default";
      const compiledPrompt = String(payload.compiledPrompt || "");
      const latestUserPrompt = String(payload.latestUserPrompt || "").trim() || "Continue";
      const requestedModel = String(payload.requestedModel || "auto").trim() || "auto";
      if (!rpcId || !requestId || !compiledPrompt) {
        replyRpc(rpcId, {
          ok: false,
          error: "执行请求缺少 requestId 或 compiledPrompt"
        });
        return;
      }
      logToContent("execute", "running", `调用 native sender requestId=${requestId}`);
      void executeNativeSend({
        requestId,
        sessionId,
        compiledPrompt,
        latestUserPrompt,
        requestedModel
      }).then((result) => {
        replyRpc(rpcId, result);
      });
      return;
    }

    if (data.type === "WEBCHAT_INSPECT") {
      const payload = toRecord(data.payload);
      const rpcId = String(payload.rpcId || "").trim();
      replyRpc(rpcId, {
        ok: true,
        ...inspectSender()
      });
      return;
    }

    if (data.type === "WEBCHAT_ABORT") {
      const payload = toRecord(data.payload);
      const requestId = String(payload.requestId || "").trim();
      const execution = pendingExecutions.get(requestId);
      if (execution?.controller) {
        execution.controller.abort();
      }
      cleanupExecution(requestId);
      logToContent("abort", "done", `收到中止请求 requestId=${requestId}`);
    }
  });
}

function bootPageHook(): void {
  installFetchHook();
  installPageMessageBridge();
  document.documentElement?.setAttribute(PAGE_HOOK_READY_ATTR, "1");
  document.documentElement?.setAttribute(CURSOR_HELP_PAGE_RUNTIME_VERSION_ATTR, CURSOR_HELP_RUNTIME_VERSION);
  syncRewriteStrategyAttr();
  logToContent("boot", "done", "cursor help page hook 已安装（native sender mode）");
  postPageMessage("WEBCHAT_PAGE_READY", {
    pageHookReady: true,
    fetchHookReady: true
  });
}

if (!(window as typeof window & Record<string, unknown>)[PAGE_HOOK_INSTALLED_FLAG]) {
  (window as typeof window & Record<string, unknown>)[PAGE_HOOK_INSTALLED_FLAG] = true;
  try {
    bootPageHook();
  } catch (error) {
    lastSenderError = error instanceof Error ? error.message : String(error);
    logToContent("boot", "failed", lastSenderError);
    console.error("[bbl] cursor help page hook boot failed", error);
  }
}
