const PAGE_SOURCE = "bbl-cursor-help-page";
const CONTENT_SOURCE = "bbl-cursor-help-content";
const PAGE_HOOK_READY_ATTR = "data-bbl-cursor-help-page-ready";
const CONTENT_INSTALLED_FLAG = "__bblCursorHelpContentInstalled";
// Keep injected content script self-contained. Do not import shared runtime-meta here.
const CURSOR_HELP_RUNTIME_VERSION = "cursor-help-runtime-2026-03-12-r1";
const CURSOR_HELP_REWRITE_STRATEGY = "system_message+user_prefix";
const CURSOR_HELP_PAGE_RUNTIME_VERSION_ATTR = "data-bbl-cursor-help-runtime-version";
const CURSOR_HELP_CONTENT_RUNTIME_VERSION_ATTR = "data-bbl-cursor-help-content-version";

type JsonRecord = Record<string, unknown>;

interface HostedWebToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface HostedChatToolCallPayload {
  callId: string;
  toolName: string;
  rawArgumentsText: string;
  parsedArguments?: unknown;
  parseError?: string;
  sourceRange: {
    start: number;
    end: number;
  };
  leadingAssistantText: string;
  trailingAssistantText: string;
}

interface HostedChatTurnResult {
  assistantText: string;
  toolCalls: HostedWebToolCall[];
  finishReason: "stop" | "tool_calls" | "transport_error";
  meta: JsonRecord;
}

type HostedChatTransportEvent =
  | {
      type: "hosted_chat.stream_text_delta";
      requestId: string;
      deltaText: string;
      meta?: JsonRecord;
    }
  | {
      type: "hosted_chat.tool_call_detected";
      requestId: string;
      assistantText: string;
      toolCalls: HostedChatToolCallPayload[];
      meta?: JsonRecord;
    }
  | {
      type: "hosted_chat.turn_resolved";
      requestId: string;
      result: HostedChatTurnResult;
    }
  | {
      type: "hosted_chat.transport_error";
      requestId: string;
      error: string;
      meta?: JsonRecord;
    }
  | {
      type: "hosted_chat.debug";
      requestId: string;
      stage: string;
      detail?: string;
      meta?: JsonRecord;
    };

function hostedFindNextNonWhitespace(text: string, start: number): string {
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (!char || /\s/.test(char)) continue;
    return char;
  }
  return "";
}

function hostedStripMarkdownFence(raw: string): string {
  const text = String(raw || "").trim();
  const fenceMatch = text.match(
    /^```(?:json|javascript|js|ts)?\s*([\s\S]*?)\s*```$/i,
  );
  return fenceMatch ? String(fenceMatch[1] || "").trim() : text;
}

function hostedNormalizeToolProtocolJsonText(raw: string): string {
  return hostedStripMarkdownFence(String(raw || ""))
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[，]/g, ",")
    .replace(/[：]/g, ":")
    .replace(/[；]/g, ";")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[｛]/g, "{")
    .replace(/[｝]/g, "}")
    .replace(/[［]/g, "[")
    .replace(/[］]/g, "]")
    .trim();
}

function hostedRepairMalformedJsonStringQuotes(raw: string): string {
  const source = hostedNormalizeToolProtocolJsonText(raw);
  if (!source) return source;
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (!inString) {
      out += char;
      if (char === "\"") {
        inString = true;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      out += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      const next = hostedFindNextNonWhitespace(source, i + 1);
      const shouldClose =
        !next || next === ":" || next === "," || next === "}" || next === "]";
      if (shouldClose) {
        out += char;
        inString = false;
      } else {
        out += "\\\"";
      }
      continue;
    }

    out += char;
  }

  return out;
}

function hostedParseToolProtocolArgs(rawArgs: string): unknown {
  const normalized = hostedNormalizeToolProtocolJsonText(rawArgs);
  try {
    return JSON.parse(normalized);
  } catch {
    return JSON.parse(hostedRepairMalformedJsonStringQuotes(normalized));
  }
}

function hostedCompactAssistantText(raw: string): string {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hostedInspectToolProtocolText(source: string): {
  assistantText: string;
  validToolCalls: HostedWebToolCall[];
  detectedToolCalls: HostedChatToolCallPayload[];
  matchedText: string;
  hasProtocolCandidate: boolean;
} {
  const text = String(source || "");
  if (!text) {
    return {
      assistantText: "",
      validToolCalls: [],
      detectedToolCalls: [],
      matchedText: "",
      hasProtocolCandidate: false,
    };
  }

  const pattern =
    /\[TM_TOOL_CALL_START:([^\]\n]+)\]([\s\S]*?)\[TM_TOOL_CALL_END:\1\]/g;
  const validToolCalls: HostedWebToolCall[] = [];
  const detectedToolCalls: HostedChatToolCallPayload[] = [];
  const matchedParts: string[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(text))) {
    const fullBlock = String(match[0] || "");
    const callId = String(match[1] || "").trim();
    const body = hostedStripMarkdownFence(String(match[2] || "").trim());
    if (!/await\s+mcp\.call\s*\(/.test(body)) continue;

    const toolPayload: HostedChatToolCallPayload = {
      callId: callId || `tool_${detectedToolCalls.length + 1}`,
      toolName: "",
      rawArgumentsText: "",
      sourceRange: {
        start: match.index,
        end: match.index + fullBlock.length,
      },
      leadingAssistantText: hostedCompactAssistantText(text.slice(0, match.index)),
      trailingAssistantText: hostedCompactAssistantText(
        text.slice(match.index + fullBlock.length),
      ),
    };

    const invokeMatch = body.match(
      /await\s+mcp\.call\(\s*(['"])([^'"]+)\1\s*,\s*([\s\S]+?)\s*\)\s*;?\s*$/,
    );
    if (!invokeMatch) {
      toolPayload.parseError = "invalid_invoke_syntax";
      detectedToolCalls.push(toolPayload);
      matchedParts.push(fullBlock);
      ranges.push(toolPayload.sourceRange);
      continue;
    }

    const toolName = String(invokeMatch[2] || "").trim();
    const rawArgumentsText = String(invokeMatch[3] || "").trim();
    toolPayload.toolName = toolName;
    toolPayload.rawArgumentsText = rawArgumentsText;
    matchedParts.push(fullBlock);
    ranges.push(toolPayload.sourceRange);

    if (!toolName || !rawArgumentsText) {
      toolPayload.parseError = "missing_tool_name_or_arguments";
      detectedToolCalls.push(toolPayload);
      continue;
    }

    try {
      const parsedArgs = hostedParseToolProtocolArgs(rawArgumentsText);
      toolPayload.parsedArguments = parsedArgs;
      validToolCalls.push({
        id: toolPayload.callId,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(parsedArgs),
        },
      });
    } catch (error) {
      toolPayload.parseError =
        error instanceof Error && error.message
          ? error.message
          : "invalid_json_arguments";
    }

    detectedToolCalls.push(toolPayload);
  }

  if (ranges.length <= 0) {
    return {
      assistantText: hostedCompactAssistantText(text),
      validToolCalls,
      detectedToolCalls,
      matchedText: "",
      hasProtocolCandidate: false,
    };
  }

  let cursor = 0;
  const segments: string[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    if (range.start > cursor) {
      segments.push(text.slice(cursor, range.start));
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }

  return {
    assistantText: hostedCompactAssistantText(segments.join("")),
    validToolCalls,
    detectedToolCalls,
    matchedText: matchedParts.join("\n"),
    hasProtocolCandidate: true,
  };
}

function buildHostedChatTurnResult(source: unknown): HostedChatTurnResult {
  const text = String(source || "");
  const inspected = hostedInspectToolProtocolText(text);
  const parseErrors = inspected.detectedToolCalls
    .filter((item) => item.parseError)
    .map((item) => ({
      callId: item.callId,
      toolName: item.toolName,
      parseError: item.parseError,
    }));
  return {
    assistantText:
      inspected.validToolCalls.length > 0
        ? inspected.assistantText
        : hostedCompactAssistantText(text),
    toolCalls: inspected.validToolCalls,
    finishReason: inspected.validToolCalls.length > 0 ? "tool_calls" : "stop",
    meta: {
      rawText: text,
      matchedText: inspected.matchedText,
      hasToolProtocolCandidate: inspected.hasProtocolCandidate,
      parseErrors,
      detectedToolCalls: inspected.detectedToolCalls,
    },
  };
}

function isCursorHelpRuntimeMismatch(runtimeVersion: string, expectedVersion = CURSOR_HELP_RUNTIME_VERSION): boolean {
  const actual = String(runtimeVersion || "").trim();
  const expected = String(expectedVersion || "").trim();
  if (!actual || !expected) return true;
  return actual !== expected;
}

const CHAT_AUTOCLICK_SELECTOR = [
  "button[title='Expand Chat Sidebar']",
  "button[aria-label='Expand Chat Sidebar']",
  "button[aria-label*='Expand Chat Sidebar']",
  "button[title*='Expand Chat Sidebar']",
  "button[aria-label*='Chat Sidebar']",
  "button[title*='Chat Sidebar']"
].join(", ");

const CHAT_INPUT_SELECTOR = [
  "textarea[aria-label='Chat message']",
  "[contenteditable='true'][aria-label='Chat message']",
  "[role='textbox'][aria-label='Chat message']",
  "textarea[placeholder='How can I help?']"
].join(", ");

const MODEL_CONTROL_SELECTOR = [
  "button",
  "[role='button']",
  "[role='option']",
  "[role='menuitemradio']",
  "[aria-selected='true']",
  "[aria-checked='true']",
  "option"
].join(", ");

const MODEL_NAME_PATTERN =
  /\b(?:claude|gpt|gemini|cursor|o1|o3|o4)(?:[\s-]*(?:\d+(?:\.\d+)?|mini|nano|pro|flash|max|thinking|fast|auto|preview|opus|sonnet|haiku|turbo|reasoning))*\b/i;

const PAGE_RPC_TIMEOUT_MS = 8_000;
const PAGE_SENDER_READY_TIMEOUT_MS = 4_000;

let pageReadyResolver: (() => void) | null = null;
let pageReadyPromise: Promise<void> | null = null;
let pageReady = false;
let extensionContextAlive = true;
const pendingRpc = new Map<string, { resolve: (value: JsonRecord) => void; reject: (reason?: unknown) => void; timeout: number }>();
const hostedRequestStateById = new Map<string, HostedRequestState>();

interface HostedRequestState {
  requestId: string;
  rawText: string;
  toolDetectedSignature: string;
}

function parseCursorHelpSseLine(line: string): {
  kind: "delta" | "done" | "error" | "ignore";
  text?: string;
  error?: string;
} {
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

function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /Extension context invalidated/i.test(message);
}

function canUseExtensionRuntime(): boolean {
  if (!extensionContextAlive) return false;
  try {
    return typeof chrome !== "undefined" && typeof chrome.runtime?.id === "string" && chrome.runtime.id.length > 0;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      extensionContextAlive = false;
      return false;
    }
    throw error;
  }
}

function safeRuntimeSendMessage(message: Record<string, unknown>): void {
  if (!canUseExtensionRuntime()) return;
  try {
    Promise.resolve(chrome.runtime.sendMessage(message)).catch((error) => {
      if (isExtensionContextInvalidated(error)) {
        extensionContextAlive = false;
      }
    });
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      extensionContextAlive = false;
      return;
    }
    throw error;
  }
}

function emitDemoLog(step: string, status: "running" | "done" | "failed", detail: string): void {
  safeRuntimeSendMessage({
    type: "cursor-help-demo.log",
    payload: {
      ts: new Date().toISOString(),
      step,
      status,
      detail
    }
  });
}

function emitWebchatTransport(payload: Record<string, unknown>): void {
  safeRuntimeSendMessage({
    type: "webchat.transport",
    ...payload
  });
}

function emitHostedTransportEvent(event: HostedChatTransportEvent): void {
  emitWebchatTransport({
    envelope: event
  });
}

function getHostedRequestState(requestId: string): HostedRequestState {
  const normalizedRequestId = String(requestId || "").trim();
  const existing = hostedRequestStateById.get(normalizedRequestId);
  if (existing) return existing;
  const next: HostedRequestState = {
    requestId: normalizedRequestId,
    rawText: "",
    toolDetectedSignature: ""
  };
  hostedRequestStateById.set(normalizedRequestId, next);
  return next;
}

function clearHostedRequestState(requestId: string): void {
  hostedRequestStateById.delete(String(requestId || "").trim());
}

function toHostedToolCallPayloads(raw: unknown): HostedChatToolCallPayload[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const range = row.sourceRange && typeof row.sourceRange === "object"
        ? (row.sourceRange as Record<string, unknown>)
        : {};
      return {
        callId: String(row.callId || "").trim(),
        toolName: String(row.toolName || "").trim(),
        rawArgumentsText: String(row.rawArgumentsText || ""),
        parsedArguments: row.parsedArguments,
        parseError: String(row.parseError || "").trim() || undefined,
        sourceRange: {
          start: Number(range.start || 0),
          end: Number(range.end || 0)
        },
        leadingAssistantText: String(row.leadingAssistantText || ""),
        trailingAssistantText: String(row.trailingAssistantText || "")
      };
    })
    .filter((item) => item.callId || item.toolName || item.rawArgumentsText);
}

function sanitizeHostedTurnMeta(meta: unknown): JsonRecord {
  const row = meta && typeof meta === "object" ? { ...(meta as JsonRecord) } : {};
  delete row.rawText;
  row.assistantTextLength = Number(row.assistantTextLength || 0);
  return row;
}

function emitToolCallDetectedIfNeeded(state: HostedRequestState): void {
  const result = buildHostedChatTurnResult(state.rawText);
  if (result.toolCalls.length <= 0) return;
  const toolCalls = toHostedToolCallPayloads(result.meta.detectedToolCalls);
  const signature = JSON.stringify(
    toolCalls.map((item) => ({
      callId: item.callId,
      toolName: item.toolName,
      rawArgumentsText: item.rawArgumentsText,
      parseError: item.parseError || ""
    }))
  );
  if (!signature || signature === state.toolDetectedSignature) return;
  state.toolDetectedSignature = signature;
  emitHostedTransportEvent({
    type: "hosted_chat.tool_call_detected",
    requestId: state.requestId,
    assistantText: result.assistantText,
    toolCalls,
    meta: {
      ...sanitizeHostedTurnMeta(result.meta),
      toolCallCount: result.toolCalls.length
    }
  });
}

function resolveHostedRequest(requestId: string, extraMeta: JsonRecord = {}): void {
  const state = getHostedRequestState(requestId);
  const result = buildHostedChatTurnResult(state.rawText);
  emitHostedTransportEvent({
    type: "hosted_chat.turn_resolved",
    requestId: state.requestId,
    result: {
      ...result,
      meta: {
        ...sanitizeHostedTurnMeta(result.meta),
        assistantTextLength: result.assistantText.length,
        ...extraMeta
      }
    }
  });
  clearHostedRequestState(state.requestId);
}

function handleHostedTransportPayload(payload: Record<string, unknown>): void {
  const requestId = String(payload.requestId || "").trim();
  if (!requestId) return;
  const transportType = String(payload.transportType || "").trim();

  if (transportType === "request_started") {
    hostedRequestStateById.set(requestId, {
      requestId,
      rawText: "",
      toolDetectedSignature: ""
    });
    emitHostedTransportEvent({
      type: "hosted_chat.debug",
      requestId,
      stage: "request_started",
      detail: "网页宿主会话已发出请求",
      meta: {
        sessionKey: String(payload.sessionKey || "").trim() || undefined,
        conversationKey: String(payload.conversationKey || "").trim() || undefined,
        rewriteDebug:
          payload.rewriteDebug && typeof payload.rewriteDebug === "object"
            ? payload.rewriteDebug
            : undefined
      }
    });
    return;
  }

  if (transportType === "sse_line") {
    const parsed = parseCursorHelpSseLine(String(payload.line || ""));
    if (parsed.kind === "ignore") return;
    if (parsed.kind === "error") {
      emitHostedTransportEvent({
        type: "hosted_chat.transport_error",
        requestId,
        error: String(parsed.error || "网页宿主聊天执行失败"),
        meta: {
          transportType
        }
      });
      clearHostedRequestState(requestId);
      return;
    }
    if (parsed.kind === "done") {
      resolveHostedRequest(requestId, { transportType: "done" });
      return;
    }

    const deltaText = String(parsed.text || "");
    if (!deltaText) return;
    const state = getHostedRequestState(requestId);
    state.rawText += deltaText;
    emitHostedTransportEvent({
      type: "hosted_chat.stream_text_delta",
      requestId,
      deltaText,
      meta: {
        accumulatedChars: state.rawText.length
      }
    });
    emitToolCallDetectedIfNeeded(state);
    return;
  }

  if (transportType === "stream_end") {
    resolveHostedRequest(requestId, { transportType });
    return;
  }

  if (
    transportType === "http_error" ||
    transportType === "invalid_response" ||
    transportType === "network_error"
  ) {
    emitHostedTransportEvent({
      type: "hosted_chat.transport_error",
      requestId,
      error: String(payload.error || payload.bodyText || "网页宿主聊天执行失败"),
      meta: {
        transportType,
        status: Number(payload.status || 0) || undefined,
        contentType: String(payload.contentType || "").trim() || undefined
      }
    });
    clearHostedRequestState(requestId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return element.getClientRects().length > 0;
}

function normalizeModelText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getButtonSignal(button: HTMLButtonElement): string {
  return normalizeModelText(
    [button.getAttribute("aria-label") || "", button.getAttribute("title") || "", button.textContent || ""].join(" ")
  ).toLowerCase();
}

function summarizeChatUiProbe(): string {
  const inputCandidates = Array.from(document.querySelectorAll(CHAT_INPUT_SELECTOR)).filter(
    (node): node is HTMLElement => node instanceof HTMLElement
  );
  const visibleInputs = inputCandidates.filter((node) => isElementVisible(node));
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (node): node is HTMLButtonElement => node instanceof HTMLButtonElement
  );
  const visibleButtons = buttons.filter((button) => isElementVisible(button) && !button.disabled);
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.tagName.toLowerCase()
      : String(document.activeElement?.nodeName || "none").toLowerCase();
  return [
    `inputs=${inputCandidates.length}`,
    `visibleInputs=${visibleInputs.length}`,
    `buttons=${buttons.length}`,
    `visibleButtons=${visibleButtons.length}`,
    `openChat=${findOpenChatButton() ? "1" : "0"}`,
    `expandChat=${findExpandChatSidebarButton() ? "1" : "0"}`,
    `visibility=${document.visibilityState}`,
    `focus=${document.hasFocus() ? "1" : "0"}`,
    `active=${activeElement}`
  ].join(", ");
}

function isLikelyModelText(text: string): boolean {
  const normalized = normalizeModelText(text);
  if (!normalized || normalized.length < 2 || normalized.length > 40) return false;
  if (!MODEL_NAME_PATTERN.test(normalized)) return false;
  return !/[{}[\]<>]/.test(normalized);
}

function getModelControlText(node: Element): string {
  return normalizeModelText(
    [
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      node.textContent || "",
    ].join(" "),
  );
}

function collectModelInfoFromNodes(nodes: Element[]): { selectedModel: string; availableModels: string[] } {
  const candidates = new Set<string>();
  let selectedModel = "";

  for (const node of nodes) {
    const text = getModelControlText(node);
    if (!isLikelyModelText(text)) continue;
    candidates.add(text);
    if (!selectedModel) {
      const selected =
        node.getAttribute("aria-selected") === "true" ||
        node.getAttribute("aria-checked") === "true" ||
        node.getAttribute("data-state") === "checked";
      if (selected) selectedModel = text;
    }
  }

  const availableModels = Array.from(candidates).slice(0, 8);
  if (!selectedModel && availableModels.length > 0) {
    selectedModel = availableModels[0];
  }

  return {
    selectedModel,
    availableModels,
  };
}

function findVisibleChatInput(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll(CHAT_INPUT_SELECTOR)).filter(
    (node): node is HTMLElement => node instanceof HTMLElement
  );
  return candidates.find((node) => isElementVisible(node)) || candidates[0] || null;
}

async function waitForChatInput(timeoutMs: number): Promise<HTMLElement | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const input = findVisibleChatInput();
    if (input) return input;
    await sleep(100);
  }
  return findVisibleChatInput();
}

function findOpenChatButton(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll("button"));
  for (const button of buttons) {
    if (!(button instanceof HTMLButtonElement)) continue;
    if (!isElementVisible(button) || button.disabled) continue;
    if (/^open chat$/i.test(getButtonSignal(button))) {
      return button;
    }
  }
  return null;
}

function findExpandChatSidebarButton(): HTMLButtonElement | null {
  const direct = document.querySelector(CHAT_AUTOCLICK_SELECTOR);
  if (direct instanceof HTMLButtonElement && isElementVisible(direct) && !direct.disabled) {
    return direct;
  }

  const buttons = Array.from(document.querySelectorAll("button"));
  for (const button of buttons) {
    if (!(button instanceof HTMLButtonElement)) continue;
    if (!isElementVisible(button) || button.disabled) continue;
    if (/(expand|toggle) chat sidebar/i.test(getButtonSignal(button))) {
      return button;
    }
  }
  return null;
}

async function ensureCursorHelpChatReady(): Promise<void> {
  if (findVisibleChatInput()) return;

  const openButton = findOpenChatButton();
  if (openButton) {
    emitDemoLog("content.chat_ui", "running", "打开 Cursor Help 聊天入口");
    openButton.click();
    if (await waitForChatInput(1_500)) return;
  }

  const expandButton = findExpandChatSidebarButton();
  if (expandButton) {
    emitDemoLog("content.chat_ui", "running", "展开 Cursor Help 聊天侧栏");
    expandButton.click();
    if (await waitForChatInput(1_500)) return;
  }

  emitDemoLog("content.chat_ui", "failed", `聊天入口仍未就绪 (${summarizeChatUiProbe()})`);
}

async function inspectPageSender(timeoutMs = 1_500): Promise<JsonRecord> {
  try {
    return (await callPage("WEBCHAT_INSPECT", {}, timeoutMs)) as JsonRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitDemoLog("content.inspect", "failed", message);
    return {
      rpcError: message,
      pageHookReady: pageReady || document.documentElement?.getAttribute(PAGE_HOOK_READY_ATTR) === "1",
      fetchHookReady: false,
      senderReady: false,
      canExecute: false,
      lastSenderError: message,
    } satisfies JsonRecord;
  }
}

function summarizePageInspect(pageInspect: JsonRecord): string {
  return [
    `pageHookReady=${pageInspect.pageHookReady === true ? 1 : 0}`,
    `fetchHookReady=${pageInspect.fetchHookReady === true ? 1 : 0}`,
    `senderReady=${pageInspect.senderReady === true ? 1 : 0}`,
    `runtimeMismatch=${pageInspect.runtimeMismatch === true ? 1 : 0}`,
    pageInspect.rpcError ? `rpcError=${String(pageInspect.rpcError)}` : "",
    pageInspect.lastSenderError ? `lastSenderError=${String(pageInspect.lastSenderError)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function formatSenderNotReadyError(pageInspect: JsonRecord): string {
  if (pageInspect.rpcError) {
    return `Cursor Help 页面 inspect 未响应。 ${String(pageInspect.rpcError || "")}`.trim();
  }
  if (pageInspect.pageHookReady !== true) {
    return "Cursor Help 页面 hook 未就绪，请稍后重试。";
  }
  if (pageInspect.fetchHookReady !== true) {
    return "Cursor Help 请求接管未就绪，请稍后重试。";
  }
  if (pageInspect.runtimeMismatch === true) {
    return String(pageInspect.runtimeMismatchReason || "Cursor Help 运行时版本不一致，请刷新页面并重载扩展。").trim();
  }
  const detail = String(pageInspect.lastSenderError || "").trim();
  if (pageInspect.senderReady !== true) {
    return `Cursor Help 内部入口未就绪。${detail ? ` ${detail}` : ""}`.trim();
  }
  return "Cursor Help 页面暂不可执行正式链路。";
}

async function waitForPageSenderReady(timeoutMs = PAGE_SENDER_READY_TIMEOUT_MS): Promise<JsonRecord> {
  const startedAt = Date.now();
  let lastInspect: JsonRecord = {};
  while (Date.now() - startedAt < timeoutMs) {
    if (!findVisibleChatInput()) {
      await ensureCursorHelpChatReady();
    }
    lastInspect = await inspectPageSender(1_200);
    if (lastInspect.runtimeMismatch === true) {
      return lastInspect;
    }
    if (lastInspect.fetchHookReady === true && lastInspect.senderReady === true) {
      return lastInspect;
    }
    await sleep(150);
  }
  emitDemoLog(
    "content.sender_probe",
    "failed",
    `sender 未就绪 (${summarizeChatUiProbe()}; last=${formatSenderNotReadyError(lastInspect)})`
  );
  return lastInspect;
}

function collectModelInfo(): { selectedModel: string; availableModels: string[] } {
  const nodes = Array.from(document.querySelectorAll(MODEL_CONTROL_SELECTOR));
  const visibleInfo = collectModelInfoFromNodes(nodes.filter((node) => isElementVisible(node)));
  if (visibleInfo.availableModels.length > 0) {
    const fallbackInfo = visibleInfo.selectedModel ? null : collectModelInfoFromNodes(nodes);
    return {
      selectedModel: visibleInfo.selectedModel || fallbackInfo?.selectedModel || visibleInfo.availableModels[0] || "",
      availableModels: visibleInfo.availableModels
    };
  }
  return collectModelInfoFromNodes(nodes);
}

function ensurePageHookInjected(): Promise<void> {
  if (document.documentElement?.getAttribute(PAGE_HOOK_READY_ATTR) === "1") {
    pageReady = true;
    return Promise.resolve();
  }
  if (pageReady) return Promise.resolve();
  if (!pageReadyPromise) {
    pageReadyPromise = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        emitDemoLog("content.ensure_page_hook", "failed", "等待 WEBCHAT_PAGE_READY 超时");
        reject(new Error("Cursor Help page hook 未就绪"));
      }, PAGE_RPC_TIMEOUT_MS);
      pageReadyResolver = () => {
        window.clearTimeout(timeout);
        resolve();
      };
    });
  }
  return pageReadyPromise;
}

function postToPage(type: string, payload: Record<string, unknown>): void {
  window.postMessage({ source: CONTENT_SOURCE, type, payload }, window.location.origin);
}

function callPage(type: string, payload: Record<string, unknown>, timeoutMs = PAGE_RPC_TIMEOUT_MS): Promise<JsonRecord> {
  const rpcId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRpc.delete(rpcId);
      reject(new Error(`页面请求超时: ${type}`));
    }, timeoutMs);
    pendingRpc.set(rpcId, {
      resolve,
      reject,
      timeout
    });
    postToPage(type, {
      ...payload,
      rpcId
    });
  });
}

const contentScope = globalThis as typeof globalThis & Record<string, unknown>;

if (!contentScope[CONTENT_INSTALLED_FLAG]) {
  contentScope[CONTENT_INSTALLED_FLAG] = true;
  document.documentElement?.setAttribute(CURSOR_HELP_CONTENT_RUNTIME_VERSION_ATTR, CURSOR_HELP_RUNTIME_VERSION);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE || !data.type) return;

    if (data.type === "WEBCHAT_PAGE_READY") {
      pageReady = true;
      emitDemoLog("content.ensure_page_hook", "done", "收到 WEBCHAT_PAGE_READY");
      pageReadyResolver?.();
      pageReadyResolver = null;
      return;
    }

    if (data.type === "WEBCHAT_RPC_RESULT") {
      const payload = data.payload && typeof data.payload === "object" ? (data.payload as JsonRecord) : {};
      const rpcId = String(payload.rpcId || "").trim();
      const entry = pendingRpc.get(rpcId);
      if (!entry) return;
      window.clearTimeout(entry.timeout);
      pendingRpc.delete(rpcId);
      entry.resolve(payload);
      return;
    }

    if (data.type === "PAGE_HOOK_LOG") {
      const payload = data.payload && typeof data.payload === "object" ? (data.payload as Record<string, unknown>) : {};
      emitDemoLog(
        `page.${String(payload.step || "log")}`,
        String(payload.status || "running") === "failed" ? "failed" : String(payload.status || "running") === "done" ? "done" : "running",
        String(payload.detail || payload.message || "")
      );
      return;
    }

    if (data.type === "WEBCHAT_TRANSPORT_EVENT") {
      const payload = data.payload && typeof data.payload === "object" ? (data.payload as Record<string, unknown>) : {};
      handleHostedTransportPayload(payload);
    }
  });

  if (canUseExtensionRuntime()) {
    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        const type = String(message?.type || "").trim();

        if (type === "webchat.execute") {
          void (async () => {
            try {
              emitDemoLog("content.execute", "running", "收到 webchat.execute");
              await ensurePageHookInjected();
              await ensureCursorHelpChatReady().catch(() => {
                // best effort only; execute path relies on page-hook's own sender wait
              });
              const preflightInspect = await inspectPageSender(800);
              emitDemoLog(
                "content.execute.preflight",
                preflightInspect.rpcError ? "failed" : "done",
                summarizePageInspect(preflightInspect),
              );
              const requestId = String(message.requestId || "").trim();
              const sessionId = String(message.sessionId || "").trim() || "default";
              const compiledPrompt = String(message.compiledPrompt || "");
              const latestUserPrompt = String(message.latestUserPrompt || "").trim() || "Continue";
              const requestedModel = String(message.requestedModel || "auto").trim() || "auto";
              const lane = String(message.lane || "primary").trim() || "primary";
              const slotId = String(message.slotId || "").trim();
              const conversationKey = String(message.conversationKey || "").trim();
              const result = await callPage(
                "WEBCHAT_EXECUTE",
                {
                  requestId,
                  sessionId,
                  compiledPrompt,
                  latestUserPrompt,
                  requestedModel,
                  lane,
                  slotId,
                  conversationKey,
                },
                PAGE_RPC_TIMEOUT_MS,
              ).catch(async (error) => {
                const message = error instanceof Error ? error.message : String(error);
                const lastInspect = await inspectPageSender(800);
                throw new Error(
                  `${message} | preflight=${summarizePageInspect(preflightInspect)} | last=${summarizePageInspect(lastInspect)}`,
                );
              });
              emitDemoLog(
                "content.execute",
                result.ok === true ? "done" : "failed",
                result.ok === true ? `native sender 已触发 requestId=${requestId}` : String(result.error || "内部入口未就绪")
              );
              sendResponse({
                ok: result.ok === true,
                error: result.ok === true ? undefined : String(result.error || "内部入口未就绪"),
                senderKind: String(result.senderKind || "").trim() || undefined
              });
            } catch (error) {
              emitDemoLog("content.execute", "failed", error instanceof Error ? error.message : String(error));
              sendResponse({
                ok: false,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          })();
          return true;
        }

        if (type === "webchat.abort") {
          clearHostedRequestState(String(message.requestId || "").trim());
          postToPage("WEBCHAT_ABORT", {
            requestId: String(message.requestId || "").trim()
          });
          sendResponse({ ok: true });
          return true;
        }

        if (type === "webchat.inspect") {
          void (async () => {
            try {
              await ensurePageHookInjected();
            } catch {
              // return current state even if page hook is not ready yet
            }

            // Inspect should not require a visible/focused chat input. In pooled
            // background tabs we only need page-hook/fetch-hook/runtime state;
            // sender readiness is allowed to converge later during execute.
            const pageInspect = await inspectPageSender(1_200);
            const info = collectModelInfo();
            const selectedModel = String(pageInspect.selectedModel || info.selectedModel || "").trim();
            const availableModels = new Set<string>(
              Array.isArray(pageInspect.availableModels)
                ? pageInspect.availableModels.map((item: unknown) => String(item || "").trim()).filter(Boolean)
                : []
            );
            for (const model of info.availableModels) {
              availableModels.add(model);
            }

            const pageHookReady = pageReady || document.documentElement?.getAttribute(PAGE_HOOK_READY_ATTR) === "1";
            const fetchHookReady = pageInspect.fetchHookReady === true;
            const senderReady = pageInspect.senderReady === true;
            const pageRuntimeVersion = String(
              pageInspect.pageRuntimeVersion || document.documentElement?.getAttribute(CURSOR_HELP_PAGE_RUNTIME_VERSION_ATTR) || ""
            ).trim();
            const runtimeMismatch = pageHookReady ? isCursorHelpRuntimeMismatch(pageRuntimeVersion, CURSOR_HELP_RUNTIME_VERSION) : false;
            const runtimeMismatchReason = runtimeMismatch
              ? `Cursor Help 页面运行时版本不一致。page=${pageRuntimeVersion || "(empty)"} expected=${CURSOR_HELP_RUNTIME_VERSION}`
              : "";
            sendResponse({
              ok: true,
              pageHookReady,
              fetchHookReady,
              senderReady,
              canExecute: pageHookReady && fetchHookReady && senderReady && !runtimeMismatch,
              selectedModel: selectedModel || undefined,
              availableModels: Array.from(availableModels),
              senderKind: String(pageInspect.senderKind || "").trim() || undefined,
              lastSenderError: String(pageInspect.lastSenderError || "").trim() || undefined,
              pageRuntimeVersion: pageRuntimeVersion || undefined,
              contentRuntimeVersion: CURSOR_HELP_RUNTIME_VERSION,
              runtimeExpectedVersion: CURSOR_HELP_RUNTIME_VERSION,
              rewriteStrategy: String(pageInspect.rewriteStrategy || CURSOR_HELP_REWRITE_STRATEGY).trim() || CURSOR_HELP_REWRITE_STRATEGY,
              runtimeMismatch,
              runtimeMismatchReason: runtimeMismatchReason || undefined,
              url: window.location.href
            });
          })();
          return true;
        }

        return false;
      });
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        extensionContextAlive = false;
      } else {
        throw error;
      }
    }
  }
}
