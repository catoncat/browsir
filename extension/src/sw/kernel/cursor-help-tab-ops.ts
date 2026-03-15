import type { CursorHelpInspectResult } from "./cursor-help-health";
import type { CursorHelpSlotRecord } from "./cursor-help-pool-policy";

export const CURSOR_HELP_URL = "https://cursor.com/help";
const CONTENT_SCRIPT_FILE = "assets/cursor-help-content.js";
const PAGE_HOOK_SCRIPT_FILE = "assets/cursor-help-page-hook.js";
const CURSOR_HELP_SESSION_SLOT_STORAGE_KEY = "cursor_help_web.session_slots";

const PERMANENT_TAB_MESSAGE_ERRORS = [
  "Could not establish connection",
  "Extension context invalidated",
  "No tab with id",
];

export function isCursorHelpUrl(raw: unknown): boolean {
  return String(raw || "").startsWith(CURSOR_HELP_URL);
}

export async function sendTabMessageWithRetry(tabId: number, message: Record<string, unknown>, retries = 12): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (PERMANENT_TAB_MESSAGE_ERRORS.some((p) => msg.includes(p))) {
        break;
      }
      const delay = Math.min(250 * 2 ** attempt, 4000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "目标网页执行器未就绪"));
}

export async function inspectCursorTab(tabId: number): Promise<CursorHelpInspectResult | null> {
  const response = await sendTabMessageWithRetry(tabId, {
    type: "webchat.inspect"
  }).catch(() => null);
  const row = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
  if (!row || row.ok !== true) return null;
  const pageHookReady = row.pageHookReady === true || row.isReady === true;
  const fetchHookReady = row.fetchHookReady === true;
  const senderReady = row.senderReady === true;
  const runtimeMismatch = row.runtimeMismatch === true;
  const canBootExecute = pageHookReady && fetchHookReady && !runtimeMismatch;
  return {
    pageHookReady,
    fetchHookReady,
    senderReady,
    canBootExecute,
    canExecute:
      row.canExecute === true ||
      (!("canExecute" in row) && canBootExecute && senderReady),
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

export async function injectCursorHelpScripts(tabId: number): Promise<void> {
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

export async function inspectCursorTabEnsured(tabId: number): Promise<CursorHelpInspectResult | null> {
  const firstTry = await inspectCursorTab(tabId);
  if (firstTry?.pageHookReady) return firstTry;
  await injectCursorHelpScripts(tabId).catch(() => {
    // noop
  });
  return inspectCursorTab(tabId);
}

export async function waitForCursorHelpTabReady(tabId: number, timeoutMs = 20_000): Promise<void> {
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

export async function waitForCursorHelpInspectReady(
  tabId: number,
  timeoutMs = 10_000,
): Promise<CursorHelpInspectResult | null> {
  const startedAt = Date.now();
  let lastInspect: CursorHelpInspectResult | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastInspect = await inspectCursorTabEnsured(tabId).catch(() => lastInspect);
    if (lastInspect) {
      return lastInspect;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return lastInspect;
}

export async function markCursorHelpTabStable(tabId: number): Promise<void> {
  await chrome.tabs
    .update(tabId, {
      autoDiscardable: false,
    })
    .catch(() => {
      // noop
    });
}

export async function isCursorHelpWindowAlive(
  windowId: number | undefined,
): Promise<boolean> {
  if (!Number.isInteger(windowId) || Number(windowId) <= 0) return false;
  const found = await chrome.windows.get(Number(windowId)).catch(() => null);
  return Boolean(found?.id);
}

export async function minimizeCursorHelpWindow(
  windowId: number | undefined,
): Promise<boolean> {
  if (!Number.isInteger(windowId) || Number(windowId) <= 0) return false;
  const found = await chrome.windows.get(Number(windowId)).catch(() => null);
  if (!found?.id) return false;
  const windowType = String(found.type || "").trim();
  if (windowType && windowType !== "popup") return false;
  await chrome.windows
    .update(Number(windowId), { state: "minimized" })
    .catch(() => {
      // noop
    });
  return true;
}

export async function readLiveCursorHelpSlot(
  slot: CursorHelpSlotRecord,
): Promise<CursorHelpSlotRecord | null> {
  const tab = await chrome.tabs.get(slot.tabId).catch(() => null);
  if (!tab?.id || !isCursorHelpUrl(tab.url)) return null;
  return {
    ...slot,
    tabId: tab.id,
    windowId:
      typeof tab.windowId === "number" && tab.windowId > 0
        ? tab.windowId
        : slot.windowId,
    lastKnownUrl: String(tab.url || slot.lastKnownUrl || ""),
  };
}

export async function clearLegacySessionSlots(): Promise<void> {
  await chrome.storage.local
    .remove(CURSOR_HELP_SESSION_SLOT_STORAGE_KEY)
    .catch(() => {
      // noop
    });
}
