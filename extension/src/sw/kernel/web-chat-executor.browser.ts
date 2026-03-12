import { buildCursorHelpCompiledPrompt, type WebToolCall, parseToolProtocolFromText } from "../../shared/cursor-help-web-shared";
import { CURSOR_HELP_WEB_BASE_URL } from "../../shared/llm-provider-config";
import {
  CURSOR_HELP_REQUEST_PATH,
  buildCursorHelpRequestBody,
  classifyCursorHelpHttpError,
  classifyCursorHelpInvalidResponse,
  createCursorHelpClientId,
  parseCursorHelpSseLine
} from "../../shared/cursor-help-protocol";
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
}

const PROVIDER_ID = "cursor_help_web";
const CURSOR_HELP_URL = "https://cursor.com/help";
const CURSOR_TAB_PATTERNS = ["https://cursor.com/help*"] as const;
const ACTIVE_BY_REQUEST_ID = new Map<string, PendingExecution>();
const ACTIVE_REQUEST_ID_BY_TAB = new Map<number, string>();
const EXECUTION_BOOT_TIMEOUT_MS = 20_000;
const EXECUTION_STALE_MS = 90_000;
const encoder = new TextEncoder();
const CONTENT_SCRIPT_FILE = "assets/cursor-help-content.js";
const PAGE_HOOK_SCRIPT_FILE = "assets/cursor-help-page-hook.js";
const CURSOR_HELP_SINGLETON_TAB_STORAGE_KEY = "cursor_help_web.singleton_tab_id";

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

function clearStaleTabExecution(tabId: number): void {
  const requestId = ACTIVE_REQUEST_ID_BY_TAB.get(tabId);
  if (!requestId) return;
  const entry = ACTIVE_BY_REQUEST_ID.get(requestId);
  if (!entry) {
    ACTIVE_REQUEST_ID_BY_TAB.delete(tabId);
    return;
  }
  if (Date.now() - entry.lastEventAt < EXECUTION_STALE_MS) return;
  failExecution(entry, "网页 provider 请求已超时，已自动回收旧执行");
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
}

async function inspectCursorTab(tabId: number): Promise<{ isReady: boolean; url: string; selectedModel?: string; availableModels?: string[] } | null> {
  const response = await sendTabMessageWithRetry(tabId, {
    type: "webchat.inspect"
  }).catch(() => null);
  const row = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
  if (!row || row.ok !== true) return null;
  return {
    isReady: row.isReady === true,
    url: String(row.url || ""),
    selectedModel: String(row.selectedModel || "").trim() || undefined,
    availableModels: Array.isArray(row.availableModels)
      ? row.availableModels.map((item) => String(item || "").trim()).filter(Boolean)
      : undefined
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

async function inspectCursorTabEnsured(tabId: number): Promise<{ isReady: boolean; url: string; selectedModel?: string; availableModels?: string[] } | null> {
  const firstTry = await inspectCursorTab(tabId);
  if (firstTry?.isReady) return firstTry;
  await injectCursorHelpScripts(tabId).catch(() => {
    // noop
  });
  return inspectCursorTab(tabId);
}

async function loadSingletonTabId(): Promise<number | null> {
  const stored = await chrome.storage.local.get(CURSOR_HELP_SINGLETON_TAB_STORAGE_KEY).catch(() => null);
  const raw = Number(stored?.[CURSOR_HELP_SINGLETON_TAB_STORAGE_KEY]);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

async function saveSingletonTabId(tabId: number): Promise<void> {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  await chrome.storage.local
    .set({
      [CURSOR_HELP_SINGLETON_TAB_STORAGE_KEY]: tabId
    })
    .catch(() => {
      // noop
    });
}

async function clearSingletonTabId(): Promise<void> {
  await chrome.storage.local.remove(CURSOR_HELP_SINGLETON_TAB_STORAGE_KEY).catch(() => {
    // noop
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

async function resolveTargetTabId(input: LlmProviderSendInput): Promise<number> {
  const options = toRecord(input.route.providerOptions);
  const singletonTabId = await loadSingletonTabId();
  if (singletonTabId) {
    const singletonTab = await chrome.tabs.get(singletonTabId).catch(() => null);
    if (singletonTab?.id) {
      await waitForCursorHelpTabReady(singletonTab.id);
      const inspected = await inspectCursorTabEnsured(singletonTab.id);
      if (inspected?.isReady) {
        return singletonTab.id;
      }
    }
    await clearSingletonTabId();
  }

  const preferredTabId = Number(options.targetTabId);
  if (Number.isInteger(preferredTabId) && preferredTabId > 0) {
    const preferredTab = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (preferredTab?.id) {
      await waitForCursorHelpTabReady(preferredTab.id);
      const inspected = await inspectCursorTabEnsured(preferredTab.id);
      if (inspected?.isReady) {
        await saveSingletonTabId(preferredTab.id);
        return preferredTab.id;
      }
    }
  }

  const existingTabs = await chrome.tabs.query({ url: [...CURSOR_TAB_PATTERNS] });
  const sortedTabs = [...existingTabs].sort((left, right) => {
    const leftHelp = String(left.url || "").startsWith(CURSOR_HELP_URL) ? 1 : 0;
    const rightHelp = String(right.url || "").startsWith(CURSOR_HELP_URL) ? 1 : 0;
    return rightHelp - leftHelp;
  });
  for (const tab of sortedTabs) {
    if (!tab.id) continue;
    await waitForCursorHelpTabReady(tab.id);
    const inspected = await inspectCursorTabEnsured(tab.id);
    if (inspected?.isReady) {
      await saveSingletonTabId(tab.id);
      return tab.id;
    }
  }

  const createdWindow = await chrome.windows.create({
    url: CURSOR_HELP_URL,
    focused: false,
    type: "popup",
    width: 420,
    height: 640
  }).catch(async () => {
    return chrome.windows.create({
      url: CURSOR_HELP_URL,
      focused: false,
      width: 420,
      height: 640
    });
  });
  const created = Array.isArray(createdWindow?.tabs) ? createdWindow.tabs[0] : null;
  if (!created?.id) {
    throw new Error("cursor_help_web 无法打开 Cursor Help 页面");
  }
  if (typeof createdWindow?.id === "number") {
    await chrome.windows.update(createdWindow.id, {
      focused: false,
      state: "minimized"
    }).catch(() => {
      // noop
    });
  }
  await chrome.tabs.update(created.id, {
    autoDiscardable: false
  }).catch(() => {
    // noop
  });
  await waitForCursorHelpTabReady(created.id);
  const inspected = await inspectCursorTabEnsured(created.id);
  if (inspected?.isReady) {
    await saveSingletonTabId(created.id);
    return created.id;
  }
  throw new Error("未找到可用的 Cursor Help 页面。请先在浏览器里打开已加载完成的 Cursor Help 页面，再重新连接。");
}

export function createCursorHelpWebProvider() {
  return {
    id: PROVIDER_ID,
    resolveRequestUrl() {
      return `${CURSOR_HELP_WEB_BASE_URL}/chat/completions`;
    },
    async send(input: LlmProviderSendInput): Promise<Response> {
      emitProviderDebugLog("provider.resolve_tab", "running", "开始解析目标 Cursor Help 标签页");
      const tabId = await resolveTargetTabId(input);
      emitProviderDebugLog("provider.resolve_tab", "done", `命中 tab=${tabId}`);
      clearStaleTabExecution(tabId);
      const existingRequestId = ACTIVE_REQUEST_ID_BY_TAB.get(tabId);
      if (existingRequestId) {
        emitProviderDebugLog("provider.lock", "failed", `tab=${tabId} 已有执行中的 provider 请求`);
        throw new Error(`目标标签页 ${tabId} 正在执行网页 provider 请求`);
      }

      const requestId = `cursor-help-${crypto.randomUUID()}`;
      const compiledPrompt = buildCursorHelpCompiledPrompt(
        input.payload.messages,
        input.payload.tools,
        input.payload.tool_choice
      );
      const requestedModel = String(input.route.llmModel || "").trim();
      const detectedModel = String(toRecord(input.route.providerOptions).detectedModel || "").trim();
      const requestBody = buildCursorHelpRequestBody({
        prompt: compiledPrompt,
        requestId,
        messageId: createCursorHelpClientId(),
        requestedModel,
        detectedModel
      });
      const entry: PendingExecution = {
        requestId,
        sessionId: String(input.sessionId || "").trim() || "default",
        tabId,
        model: requestBody.model,
        stream: input.payload.stream !== false,
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        startedAt: null,
        timeoutHandle: null,
        controller: null,
        queue: [],
        outputText: "",
        firstDeltaLogged: false,
        closed: false
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
      ACTIVE_REQUEST_ID_BY_TAB.set(tabId, requestId);
      armExecutionWatchdog(entry, EXECUTION_BOOT_TIMEOUT_MS, "网页 provider 请求未启动，请确认 Cursor Help 页面已加载完成");
      emitProviderDebugLog("provider.execute", "running", `向 tab=${tabId} 发送 webchat.execute`);

      input.signal.addEventListener(
        "abort",
        () => {
          void chrome.tabs.sendMessage(tabId, {
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
        const response = await sendTabMessageWithRetry(tabId, {
          type: "webchat.execute",
          requestId,
          targetSite: "cursor_help",
          requestUrl: CURSOR_HELP_REQUEST_PATH,
          requestBody
        });
        const row = toRecord(response);
        if (row.ok !== true) {
          emitProviderDebugLog("provider.execute", "failed", String(row.error || "目标网页执行器未就绪"));
          throw new Error(String(row.error || "目标网页执行器未就绪"));
        }
        emitProviderDebugLog("provider.execute", "done", "content script 已确认接收 execute 请求");
      } catch (error) {
        ACTIVE_BY_REQUEST_ID.delete(requestId);
        ACTIVE_REQUEST_ID_BY_TAB.delete(tabId);
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
  if (transportType === "request_started") {
    entry.startedAt = Date.now();
    armExecutionWatchdog(entry, EXECUTION_STALE_MS, "网页 provider 请求长时间未结束");
    emitProviderDebugLog("provider.request_started", "done", `tab=${entry.tabId} 页面内聊天请求已发出`);
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
