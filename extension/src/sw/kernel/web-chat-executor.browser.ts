import {
  buildCursorHelpCompiledPrompt,
  extractLastUserMessage,
  type WebToolCall,
  parseToolProtocolFromText
} from "../../shared/cursor-help-web-shared";
import { CURSOR_HELP_WEB_BASE_URL } from "../../shared/llm-provider-config";
import {
  classifyCursorHelpHttpError,
  classifyCursorHelpInvalidResponse,
  parseCursorHelpSseLine,
  resolveCursorHelpApiModel,
  type CursorHelpSenderInspect
} from "../../shared/cursor-help-protocol";
import { CURSOR_HELP_RUNTIME_VERSION } from "../../shared/cursor-help-runtime-meta";
import type { LlmProviderSendInput } from "./llm-provider";

type JsonRecord = Record<string, unknown>;

type WebChatTransportType =
  | "request_started"
  | "sse_line"
  | "stream_end"
  | "http_error"
  | "invalid_response"
  | "network_error";

interface PendingExecution {
  requestId: string;
  sessionId: string;
  tabId: number;
  model: string;
  stream: boolean;
  createdAt: number;
  lastEventAt: number;
  startedAt: number | null;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  queue: Uint8Array[];
  outputText: string;
  firstDeltaLogged: boolean;
  closed: boolean;
  sessionKey: string | null;
}

interface CursorHelpSlotRecord {
  sessionId: string;
  tabId: number;
  windowId?: number;
  lastKnownUrl: string;
  lastReadyAt: number;
}

interface CursorHelpInspectResult extends CursorHelpSenderInspect {
  url: string;
  selectedModel?: string;
  availableModels?: string[];
}

const PROVIDER_ID = "cursor_help_web";
const CURSOR_HELP_URL = "https://cursor.com/help";
const CURSOR_TAB_PATTERNS = ["https://cursor.com/help*"] as const;
const ACTIVE_BY_REQUEST_ID = new Map<string, PendingExecution>();
const ACTIVE_REQUEST_ID_BY_TAB = new Map<number, string>();
const ACTIVE_REQUEST_ID_BY_SESSION = new Map<string, string>();
const EXECUTION_BOOT_TIMEOUT_MS = 20_000;
const EXECUTION_STALE_MS = 90_000;
const encoder = new TextEncoder();
const CONTENT_SCRIPT_FILE = "assets/cursor-help-content.js";
const PAGE_HOOK_SCRIPT_FILE = "assets/cursor-help-page-hook.js";
const CURSOR_HELP_SESSION_SLOT_STORAGE_KEY = "cursor_help_web.session_slots";
const CURSOR_HELP_CONTAINER_WIDTH = 1280;
const CURSOR_HELP_CONTAINER_HEIGHT = 900;
let cursorHelpSlotLifecycleBoundTabs: typeof chrome.tabs | null = null;

function emitProviderDebugLog(step: string, status: "running" | "done" | "failed", detail: string): void {
  void chrome.runtime.sendMessage({
    type: "cursor-help-demo.log",
    payload: {
      ts: new Date().toISOString(),
      step,
      status,
      detail
    }
  }).catch(() => {
    // sidepanel may be closed
  });
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function formatRewriteDebugSummary(raw: unknown): string {
  const debug = toRecord(raw);
  if (Object.keys(debug).length <= 0) return "";
  const targetMessageIndex = debug.targetMessageIndex;
  const targetLabel =
    typeof targetMessageIndex === "number"
      ? `messages[${targetMessageIndex}]`
      : String(debug.targetKind || "").trim() === "input"
        ? "input"
        : "none";
  return [
    `runtime=${String(debug.runtimeVersion || "").trim() || CURSOR_HELP_RUNTIME_VERSION}`,
    `strategy=${String(debug.rewriteStrategy || "").trim() || "(unknown)"}`,
    `target=${targetLabel}`,
    `targetKind=${String(debug.targetKind || "").trim() || "none"}`,
    `system=${debug.systemMessageInjected === true ? "1" : "0"}`,
    `user=${debug.userPromptInjected === true ? "1" : "0"}`,
    `promptHash=${String(debug.compiledPromptHash || "").trim() || "-"}`,
    `promptLen=${Number(debug.compiledPromptLength || 0)}`,
    `origLen=${Number(debug.originalTargetLength || 0)}`,
    `nextLen=${Number(debug.rewrittenTargetLength || 0)}`
  ].join(" ");
}

function buildChunk(requestId: string, model: string, delta: JsonRecord, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  })}\n\n`;
}

function enqueueSse(entry: PendingExecution, payload: string): void {
  if (entry.closed) return;
  const chunk = encoder.encode(payload);
  if (entry.controller) {
    entry.controller.enqueue(chunk);
    return;
  }
  entry.queue.push(chunk);
}

function closeExecution(entry: PendingExecution): void {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }
  ACTIVE_BY_REQUEST_ID.delete(entry.requestId);
  ACTIVE_REQUEST_ID_BY_TAB.delete(entry.tabId);
  ACTIVE_REQUEST_ID_BY_SESSION.delete(entry.sessionId);
  if (entry.controller) {
    entry.controller.close();
  }
}

function buildJsonResponseBody(entry: PendingExecution, finishReason: string | null = "stop"): string {
  return JSON.stringify({
    id: `chatcmpl-${entry.requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: entry.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: entry.outputText
        },
        finish_reason: finishReason
      }
    ]
  });
}

function normalizeTransportErrorMessage(payload: JsonRecord): string {
  const transportType = String(payload.transportType || "").trim();
  if (transportType === "http_error") {
    return classifyCursorHelpHttpError(Number(payload.status || 0), String(payload.bodyText || ""));
  }
  if (transportType === "invalid_response") {
    return classifyCursorHelpInvalidResponse(
      Number(payload.status || 0),
      String(payload.contentType || ""),
      String(payload.bodyText || "")
    );
  }
  return String(payload.error || "网页聊天执行失败");
}

function failExecution(entry: PendingExecution, error: string): void {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }
  ACTIVE_BY_REQUEST_ID.delete(entry.requestId);
  ACTIVE_REQUEST_ID_BY_TAB.delete(entry.tabId);
  ACTIVE_REQUEST_ID_BY_SESSION.delete(entry.sessionId);
  if (entry.startedAt === null) {
    void clearSessionSlotIfMatches(entry.sessionId, entry.tabId)
      .then(() => {
        emitProviderDebugLog(
          "provider.slot_reset",
          "done",
          `session=${entry.sessionId} startup failed, reset slot tab=${entry.tabId}`
        );
      })
      .catch(() => {
        // noop
      });
  }
  if (entry.controller) {
    entry.controller.error(new Error(error));
  }
}

function touchExecution(entry: PendingExecution): void {
  entry.lastEventAt = Date.now();
}

function armExecutionWatchdog(entry: PendingExecution, timeoutMs: number, reason: string): void {
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
  }
  entry.timeoutHandle = setTimeout(() => {
    failExecution(entry, reason);
  }, timeoutMs);
}

function clearStaleExecution(sessionId: string, tabId: number): void {
  const requestIds = new Set<string>();
  const bySession = ACTIVE_REQUEST_ID_BY_SESSION.get(sessionId);
  const byTab = ACTIVE_REQUEST_ID_BY_TAB.get(tabId);
  if (bySession) requestIds.add(bySession);
  if (byTab) requestIds.add(byTab);
  for (const requestId of requestIds) {
    const entry = ACTIVE_BY_REQUEST_ID.get(requestId);
    if (!entry) {
      ACTIVE_REQUEST_ID_BY_SESSION.delete(sessionId);
      ACTIVE_REQUEST_ID_BY_TAB.delete(tabId);
      continue;
    }
    if (Date.now() - entry.lastEventAt < EXECUTION_STALE_MS) continue;
    failExecution(entry, "网页 provider 请求已超时，已自动回收旧执行");
  }
}

async function waitForCursorHelpTabReady(tabId: number, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.id && tab.status === "complete" && String(tab.url || "").startsWith(CURSOR_HELP_URL)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待 Cursor Help 页面加载超时");
}

async function inspectCursorTab(tabId: number): Promise<CursorHelpInspectResult | null> {
  const response = await sendTabMessageWithRetry(tabId, {
    type: "webchat.inspect"
  }).catch(() => null);
  const row = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
  if (!row || row.ok !== true) return null;
  const pageHookReady = row.pageHookReady === true || row.isReady === true;
  const fetchHookReady = row.fetchHookReady === true;
  const senderReady = row.senderReady === true;
  const runtimeMismatch = row.runtimeMismatch === true;
  return {
    pageHookReady,
    fetchHookReady,
    senderReady,
    canExecute:
      row.canExecute === true ||
      (!("canExecute" in row) && pageHookReady && fetchHookReady && senderReady && !runtimeMismatch),
    url: String(row.url || ""),
    selectedModel: String(row.selectedModel || "").trim() || undefined,
    availableModels: Array.isArray(row.availableModels)
      ? row.availableModels.map((item) => String(item || "").trim()).filter(Boolean)
      : undefined,
    senderKind: String(row.senderKind || "").trim() || undefined,
    lastSenderError: String(row.lastSenderError || "").trim() || undefined,
    pageRuntimeVersion: String(row.pageRuntimeVersion || "").trim() || undefined,
    contentRuntimeVersion: String(row.contentRuntimeVersion || "").trim() || undefined,
    runtimeExpectedVersion: String(row.runtimeExpectedVersion || "").trim() || undefined,
    rewriteStrategy: String(row.rewriteStrategy || "").trim() || undefined,
    runtimeMismatch,
    runtimeMismatchReason: String(row.runtimeMismatchReason || "").trim() || undefined
  };
}

async function injectCursorHelpScripts(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [PAGE_HOOK_SCRIPT_FILE],
    world: "MAIN"
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_SCRIPT_FILE]
  });
}

async function inspectCursorTabEnsured(tabId: number): Promise<CursorHelpInspectResult | null> {
  const firstTry = await inspectCursorTab(tabId);
  if (firstTry?.pageHookReady) return firstTry;
  await injectCursorHelpScripts(tabId).catch(() => {
    // noop
  });
  return inspectCursorTab(tabId);
}

async function loadSessionSlots(): Promise<Record<string, CursorHelpSlotRecord>> {
  const stored = await chrome.storage.local.get(CURSOR_HELP_SESSION_SLOT_STORAGE_KEY).catch(() => null);
  const raw = toRecord(stored?.[CURSOR_HELP_SESSION_SLOT_STORAGE_KEY]);
  const slots: Record<string, CursorHelpSlotRecord> = {};
  for (const [sessionId, value] of Object.entries(raw)) {
    const row = toRecord(value);
    const tabId = Number(row.tabId);
    if (!sessionId.trim() || !Number.isInteger(tabId) || tabId <= 0) continue;
    slots[sessionId] = {
      sessionId,
      tabId,
      windowId: Number.isInteger(Number(row.windowId)) ? Number(row.windowId) : undefined,
      lastKnownUrl: String(row.lastKnownUrl || ""),
      lastReadyAt: Number(row.lastReadyAt || 0)
    };
  }
  return slots;
}

async function persistSessionSlots(slots: Record<string, CursorHelpSlotRecord>): Promise<void> {
  await chrome.storage.local
    .set({
      [CURSOR_HELP_SESSION_SLOT_STORAGE_KEY]: slots
    })
    .catch(() => {
      // noop
    });
}

async function saveSessionSlot(slot: CursorHelpSlotRecord): Promise<void> {
  const slots = await loadSessionSlots();
  slots[slot.sessionId] = slot;
  await persistSessionSlots(slots);
}

async function clearSessionSlot(sessionId: string): Promise<void> {
  const slots = await loadSessionSlots();
  delete slots[sessionId];
  await persistSessionSlots(slots);
}

async function clearSessionSlotIfMatches(sessionId: string, tabId: number): Promise<void> {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId || !Number.isInteger(tabId) || tabId <= 0) return;
  const slots = await loadSessionSlots();
  if (Number(slots[normalizedSessionId]?.tabId) !== tabId) return;
  delete slots[normalizedSessionId];
  await persistSessionSlots(slots);
}

async function clearSessionSlotsByTabId(tabId: number): Promise<void> {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const slots = await loadSessionSlots();
  let changed = false;
  for (const [sessionId, slot] of Object.entries(slots)) {
    if (Number(slot.tabId) !== tabId) continue;
    delete slots[sessionId];
    changed = true;
  }
  if (!changed) return;
  await persistSessionSlots(slots);
}

function ensureCursorHelpSlotLifecycle(): void {
  const tabsApi = chrome.tabs;
  if (!tabsApi?.onRemoved?.addListener) return;
  if (cursorHelpSlotLifecycleBoundTabs === tabsApi) return;
  cursorHelpSlotLifecycleBoundTabs = tabsApi;
  tabsApi.onRemoved.addListener((tabId) => {
    void clearSessionSlotsByTabId(tabId);
  });
}

async function sendTabMessageWithRetry(tabId: number, message: Record<string, unknown>, retries = 12): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "目标网页执行器未就绪"));
}

function formatInspectFailure(inspect: CursorHelpInspectResult | null): string {
  if (!inspect) return "未找到可用的 Cursor Help 页面。请确认页面已完成加载。";
  if (!inspect.pageHookReady) return "Cursor Help 页面 hook 未就绪，请稍后重试。";
  if (!inspect.fetchHookReady) return "Cursor Help 请求接管未就绪，请稍后重试。";
  if (inspect.runtimeMismatch) {
    const suffix = inspect.runtimeMismatchReason ? ` ${inspect.runtimeMismatchReason}` : "";
    return `Cursor Help 运行时版本不一致。${suffix}`.trim();
  }
  if (!inspect.senderReady) {
    const suffix = inspect.lastSenderError ? ` ${inspect.lastSenderError}` : "";
    return `Cursor Help 内部入口未就绪。${suffix}`.trim();
  }
  return "Cursor Help 页面暂不可执行正式链路。";
}

function shouldPropagateInspectFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /运行时版本不一致/i.test(message);
}

async function tryUseTabForSession(
  sessionId: string,
  tabId: number
): Promise<{ tabId: number; inspect: CursorHelpInspectResult; windowId?: number } | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id) return null;
  await waitForCursorHelpTabReady(tab.id);
  const inspect = await inspectCursorTabEnsured(tab.id);
  if (inspect?.runtimeMismatch) {
    throw new Error(formatInspectFailure(inspect));
  }
  if (!inspect?.canExecute) return null;
  await saveSessionSlot({
    sessionId,
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : undefined,
    lastKnownUrl: inspect.url,
    lastReadyAt: Date.now()
  });
  return {
    tabId: tab.id,
    inspect,
    windowId: typeof tab.windowId === "number" ? tab.windowId : undefined
  };
}

async function resolveTargetSlot(
  input: LlmProviderSendInput
): Promise<{ sessionId: string; tabId: number; inspect: CursorHelpInspectResult }> {
  const sessionId = String(input.sessionId || "").trim() || "default";
  const options = toRecord(input.route.providerOptions);
  const slots = await loadSessionSlots();
  const boundTabIds = new Set<number>(
    Object.values(slots)
      .map((slot) => Number(slot.tabId))
      .filter((tabId) => Number.isInteger(tabId) && tabId > 0)
  );

  const existingSlot = slots[sessionId];
  if (existingSlot?.tabId) {
    const resolved = await tryUseTabForSession(sessionId, existingSlot.tabId).catch((error) => {
      if (shouldPropagateInspectFailure(error)) throw error;
      return null;
    });
    if (resolved) {
      return {
        sessionId,
        tabId: resolved.tabId,
        inspect: resolved.inspect
      };
    }
    await clearSessionSlot(sessionId);
  }

  const preferredTabId = Number(options.targetTabId);
  if (Number.isInteger(preferredTabId) && preferredTabId > 0) {
    const alreadyBoundSession = Object.values(slots).find(
      (slot) => slot.sessionId !== sessionId && slot.tabId === preferredTabId
    );
    if (!alreadyBoundSession) {
      const resolved = await tryUseTabForSession(sessionId, preferredTabId).catch((error) => {
        if (shouldPropagateInspectFailure(error)) throw error;
        return null;
      });
      if (resolved) {
        return {
          sessionId,
          tabId: resolved.tabId,
          inspect: resolved.inspect
        };
      }
    }
  }

  const existingTabs = await chrome.tabs.query({ url: [...CURSOR_TAB_PATTERNS] });
  for (const tab of existingTabs) {
    if (!tab.id) continue;
    if (boundTabIds.has(tab.id)) continue;
    const resolved = await tryUseTabForSession(sessionId, tab.id).catch((error) => {
      if (shouldPropagateInspectFailure(error)) throw error;
      return null;
    });
    if (resolved) {
      return {
        sessionId,
        tabId: resolved.tabId,
        inspect: resolved.inspect
      };
    }
  }

  const createdWindow = await chrome.windows.create({
    url: CURSOR_HELP_URL,
    focused: false,
    type: "popup",
    width: CURSOR_HELP_CONTAINER_WIDTH,
    height: CURSOR_HELP_CONTAINER_HEIGHT
  }).catch(async () => {
    return chrome.windows.create({
      url: CURSOR_HELP_URL,
      focused: false,
      width: CURSOR_HELP_CONTAINER_WIDTH,
      height: CURSOR_HELP_CONTAINER_HEIGHT
    });
  });
  const created = Array.isArray(createdWindow?.tabs) ? createdWindow.tabs[0] : null;
  if (!created?.id) {
    throw new Error("cursor_help_web 无法打开 Cursor Help 页面");
  }
  await chrome.tabs.update(created.id, {
    autoDiscardable: false
  }).catch(() => {
    // noop
  });
  await waitForCursorHelpTabReady(created.id);
  const inspect = await inspectCursorTabEnsured(created.id);
  if (inspect?.canExecute) {
    await saveSessionSlot({
      sessionId,
      tabId: created.id,
      windowId: typeof created.windowId === "number" ? created.windowId : undefined,
      lastKnownUrl: inspect.url,
      lastReadyAt: Date.now()
    });
    return {
      sessionId,
      tabId: created.id,
      inspect
    };
  }
  throw new Error(formatInspectFailure(inspect));
}

export function createCursorHelpWebProvider() {
  ensureCursorHelpSlotLifecycle();
  return {
    id: PROVIDER_ID,
    resolveRequestUrl() {
      return `${CURSOR_HELP_WEB_BASE_URL}/chat/completions`;
    },
    async send(input: LlmProviderSendInput): Promise<Response> {
      emitProviderDebugLog("provider.resolve_slot", "running", "开始解析目标 Cursor Help 会话槽位");
      const resolved = await resolveTargetSlot(input);
      emitProviderDebugLog("provider.resolve_slot", "done", `session=${resolved.sessionId} 命中 tab=${resolved.tabId}`);
      clearStaleExecution(resolved.sessionId, resolved.tabId);

      if (ACTIVE_REQUEST_ID_BY_SESSION.has(resolved.sessionId)) {
        throw new Error(`会话 ${resolved.sessionId} 已有执行中的网页 provider 请求`);
      }
      if (ACTIVE_REQUEST_ID_BY_TAB.has(resolved.tabId)) {
        throw new Error(`目标标签页 ${resolved.tabId} 正在执行网页 provider 请求`);
      }

      const requestId = `cursor-help-${crypto.randomUUID()}`;
      const compiledPrompt = buildCursorHelpCompiledPrompt(
        input.payload.messages,
        input.payload.tools,
        input.payload.tool_choice
      );
      const latestUserPrompt = extractLastUserMessage(input.payload.messages);
      const requestedModel = String(input.route.llmModel || "").trim() || "auto";
      const entry: PendingExecution = {
        requestId,
        sessionId: resolved.sessionId,
        tabId: resolved.tabId,
        model: resolveCursorHelpApiModel(requestedModel, resolved.inspect.selectedModel || ""),
        stream: input.payload.stream !== false,
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        startedAt: null,
        timeoutHandle: null,
        controller: null,
        queue: [],
        outputText: "",
        firstDeltaLogged: false,
        closed: false,
        sessionKey: null
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          entry.controller = controller;
          for (const chunk of entry.queue.splice(0, entry.queue.length)) {
            controller.enqueue(chunk);
          }
        },
        cancel() {
          closeExecution(entry);
        }
      });

      ACTIVE_BY_REQUEST_ID.set(requestId, entry);
      ACTIVE_REQUEST_ID_BY_TAB.set(resolved.tabId, requestId);
      ACTIVE_REQUEST_ID_BY_SESSION.set(resolved.sessionId, requestId);
      armExecutionWatchdog(entry, EXECUTION_BOOT_TIMEOUT_MS, "网页 provider 请求未启动，请确认 Cursor Help 页面已加载完成");
      emitProviderDebugLog("provider.execute", "running", `向 tab=${resolved.tabId} 发送 webchat.execute`);

      input.signal.addEventListener(
        "abort",
        () => {
          void chrome.tabs.sendMessage(resolved.tabId, {
            type: "webchat.abort",
            requestId
          }).catch(() => {
            // noop
          });
          failExecution(entry, "webchat provider aborted");
        },
        { once: true }
      );

      try {
        const response = await sendTabMessageWithRetry(resolved.tabId, {
          type: "webchat.execute",
          requestId,
          sessionId: resolved.sessionId,
          compiledPrompt,
          latestUserPrompt,
          requestedModel
        });
        const row = toRecord(response);
        if (row.ok !== true) {
          emitProviderDebugLog("provider.execute", "failed", String(row.error || "目标网页执行器未就绪"));
          throw new Error(String(row.error || "目标网页执行器未就绪"));
        }
        emitProviderDebugLog(
          "provider.execute",
          "done",
          `content script 已确认接收 execute 请求${row.senderKind ? ` (${String(row.senderKind)})` : ""}`
        );
      } catch (error) {
        ACTIVE_BY_REQUEST_ID.delete(requestId);
        ACTIVE_REQUEST_ID_BY_TAB.delete(resolved.tabId);
        ACTIVE_REQUEST_ID_BY_SESSION.delete(resolved.sessionId);
        void clearSessionSlotIfMatches(resolved.sessionId, resolved.tabId).catch(() => {
          // noop
        });
        emitProviderDebugLog("provider.execute", "failed", error instanceof Error ? error.message : String(error));
        throw error instanceof Error ? error : new Error(String(error));
      }

      if (!entry.stream) {
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-cache"
          }
        });
      }

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache"
        }
      });
    }
  };
}

function emitToolCalls(entry: PendingExecution, toolCalls: WebToolCall[]): void {
  if (toolCalls.length <= 0) return;
  if (!entry.stream) {
    failExecution(entry, "cursor_help_web 目前不支持在非流式请求中返回 tool_calls");
    return;
  }
  enqueueSse(
    entry,
    buildChunk(
      entry.requestId,
      entry.model,
      {
        tool_calls: toolCalls.map((call, index) => ({
          ...call,
          index
        }))
      }
    )
  );
  enqueueSse(entry, buildChunk(entry.requestId, entry.model, {}, "tool_calls"));
  enqueueSse(entry, "data: [DONE]\n\n");
  closeExecution(entry);
}

function emitFinalDone(entry: PendingExecution): void {
  if (!entry.stream) {
    enqueueSse(entry, buildJsonResponseBody(entry));
    closeExecution(entry);
    return;
  }
  enqueueSse(entry, buildChunk(entry.requestId, entry.model, {}, "stop"));
  enqueueSse(entry, "data: [DONE]\n\n");
  closeExecution(entry);
}

export async function handleWebChatRuntimeMessage(message: unknown, senderTabId?: number): Promise<boolean> {
  const payload = toRecord(message);
  if (String(payload.type || "").trim() !== "webchat.transport") return false;

  const requestId = String(payload.requestId || "").trim();
  if (!requestId) return true;
  const entry = ACTIVE_BY_REQUEST_ID.get(requestId);
  if (!entry) return true;
  if (senderTabId && entry.tabId !== senderTabId) return true;

  const transportType = String(payload.transportType || "").trim() as WebChatTransportType;
  touchExecution(entry);
  if (typeof payload.sessionKey === "string" && payload.sessionKey.trim()) {
    entry.sessionKey = payload.sessionKey.trim();
  }
  if (transportType === "request_started") {
    entry.startedAt = Date.now();
    armExecutionWatchdog(entry, EXECUTION_STALE_MS, "网页 provider 请求长时间未结束");
    emitProviderDebugLog(
      "provider.request_started",
      "done",
      `tab=${entry.tabId} 页面内聊天请求已发出${entry.sessionKey ? ` sessionKey=${entry.sessionKey}` : ""}`
    );
    const rewriteSummary = formatRewriteDebugSummary(payload.rewriteDebug);
    if (rewriteSummary) {
      emitProviderDebugLog("provider.request_rewrite", "done", rewriteSummary);
    }
    return true;
  }

  if (transportType === "sse_line") {
    const parsedEvent = parseCursorHelpSseLine(String(payload.line || ""));
    if (parsedEvent.kind === "ignore") return true;
    if (parsedEvent.kind === "error") {
      emitProviderDebugLog("provider.error", "failed", String(parsedEvent.error || "网页聊天执行失败"));
      failExecution(entry, String(parsedEvent.error || "网页聊天执行失败"));
      return true;
    }
    if (parsedEvent.kind === "done") {
      if (!entry.closed) emitFinalDone(entry);
      emitProviderDebugLog("provider.done", "done", "网页 provider 请求完成");
      return true;
    }

    const text = String(parsedEvent.text || "");
    if (!text) return true;
    entry.outputText += text;
    const protocol = parseToolProtocolFromText(entry.outputText);
    if (protocol?.toolCalls.length) {
      emitToolCalls(entry, protocol.toolCalls);
      return true;
    }
    if (entry.stream) {
      enqueueSse(entry, buildChunk(entry.requestId, entry.model, { content: text }));
    }
    if (!entry.firstDeltaLogged) {
      entry.firstDeltaLogged = true;
      emitProviderDebugLog("provider.first_delta", "done", `收到输出片段，长度=${text.length}`);
    }
    armExecutionWatchdog(entry, EXECUTION_STALE_MS, "网页 provider 请求长时间无新输出");
    return true;
  }

  if (transportType === "stream_end") {
    if (!entry.closed) emitFinalDone(entry);
    emitProviderDebugLog("provider.done", "done", "网页 provider 数据流结束");
    return true;
  }

  if (transportType === "http_error" || transportType === "invalid_response" || transportType === "network_error") {
    const error = normalizeTransportErrorMessage(payload);
    emitProviderDebugLog("provider.error", "failed", error);
    failExecution(entry, error);
    return true;
  }

  return true;
}
