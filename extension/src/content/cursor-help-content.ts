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

function isLikelyModelText(text: string): boolean {
  const normalized = normalizeModelText(text);
  if (!normalized || normalized.length < 2 || normalized.length > 40) return false;
  if (!MODEL_NAME_PATTERN.test(normalized)) return false;
  return !/[{}[\]<>]/.test(normalized);
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
}

async function inspectPageSender(timeoutMs = 1_500): Promise<JsonRecord> {
  return (await callPage("WEBCHAT_INSPECT", {}, timeoutMs).catch(() => ({} as JsonRecord))) as JsonRecord;
}

function formatSenderNotReadyError(pageInspect: JsonRecord): string {
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
  return lastInspect;
}

function collectModelInfo(): { selectedModel: string; availableModels: string[] } {
  const candidates = new Set<string>();
  let selectedModel = "";

  const nodes = Array.from(document.querySelectorAll(MODEL_CONTROL_SELECTOR));
  for (const node of nodes) {
    if (!isElementVisible(node)) continue;
    const text = normalizeModelText(node.textContent || "");
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
    availableModels
  };
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
      emitWebchatTransport(payload);
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
              await ensureCursorHelpChatReady();
              const pageInspect = await waitForPageSenderReady();
              if (pageInspect.fetchHookReady !== true || pageInspect.senderReady !== true) {
                const error = formatSenderNotReadyError(pageInspect);
                emitDemoLog("content.execute", "failed", error);
                sendResponse({
                  ok: false,
                  error
                });
                return;
              }
              const requestId = String(message.requestId || "").trim();
              const sessionId = String(message.sessionId || "").trim() || "default";
              const compiledPrompt = String(message.compiledPrompt || "");
              const latestUserPrompt = String(message.latestUserPrompt || "").trim() || "Continue";
              const requestedModel = String(message.requestedModel || "auto").trim() || "auto";
              const result = await callPage("WEBCHAT_EXECUTE", {
                requestId,
                sessionId,
                compiledPrompt,
                latestUserPrompt,
                requestedModel
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
              await ensureCursorHelpChatReady();
            } catch {
              // return current state even if page hook is not ready yet
            }

            const pageInspect = await waitForPageSenderReady(2_000);
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
