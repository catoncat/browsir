import {
  buildCursorHelpCompiledPrompt,
  extractLastUserMessage,
  parseHostedChatTransportEvent,
  serializeHostedChatTransportEvent,
  type HostedChatTransportEvent
} from "../../shared/cursor-help-web-shared";
import {
  type CursorHelpSenderInspect,
} from "../../shared/cursor-help-protocol";
import { CURSOR_HELP_RUNTIME_VERSION } from "../../shared/cursor-help-runtime-meta";
import type {
  LlmProviderExecutionLane,
  LlmProviderSendInput,
} from "./llm-provider";
import {
  type CursorHelpSlotRecord,
  type CursorHelpPoolState,
  type CursorHelpWindowPolicyState,
  type CursorHelpWindowStatus,
  withWindowEvent,
  buildCursorHelpWindowPolicyState,
  resolveCursorHelpWindowRuntimeState,
  resolveMissingPoolWindowRecoveryAction,
  buildCursorHelpWindowRecoveryPreview,
  buildCursorHelpAdoptDecisionPreview,
  buildCursorHelpBackgroundDecisionPreview,
  sortSlotsForDisplay,
  normalizeExecutionLane,
  toSlotLanePreference,
  buildSessionLaneKey,
} from "./cursor-help-pool-policy";

type JsonRecord = Record<string, unknown>;

interface PendingExecution {
  requestId: string;
  sessionId: string;
  slotId: string;
  lane: LlmProviderExecutionLane;
  tabId: number;
  windowId?: number;
  createdAt: number;
  lastEventAt: number;
  startedAt: number | null;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  queue: Uint8Array[];
  firstDeltaLogged: boolean;
  conversationKey: string | null;
  closed: boolean;
}



interface CursorHelpInspectResult extends CursorHelpSenderInspect {
  url: string;
  selectedModel?: string;
  availableModels?: string[];
  canBootExecute?: boolean;
}

interface CursorHelpPoolDebugView {
  summary: JsonRecord;
  window: JsonRecord | null;
  slots: JsonRecord[];
}

const PROVIDER_ID = "cursor_help_web";
const CURSOR_HELP_URL = "https://cursor.com/help";
const CURSOR_TAB_PATTERNS = ["https://cursor.com/help*"] as const;
const ACTIVE_BY_REQUEST_ID = new Map<string, PendingExecution>();
const ACTIVE_REQUEST_ID_BY_SLOT = new Map<string, string>();
const ACTIVE_REQUEST_ID_BY_TAB = new Map<number, string>();
const ACTIVE_REQUEST_ID_BY_SESSION_LANE = new Map<string, string>();
const PREFERRED_SLOT_ID_BY_SESSION = new Map<string, string>();
const PREFERRED_SLOT_ID_BY_CONVERSATION = new Map<string, string>();
const LAST_CONVERSATION_KEY_BY_SESSION = new Map<string, string>();
const EXECUTION_BOOT_TIMEOUT_MS = 20_000;
const EXECUTION_STALE_MS = 90_000;
const SLOT_WAIT_POLL_MS = 200;
const PRIMARY_SLOT_WAIT_MS = 15_000;
const AUXILIARY_SLOT_WAIT_MS = 10_000;
const DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT = 3;
const MIN_CURSOR_HELP_POOL_SLOT_COUNT = 2;
const MAX_CURSOR_HELP_POOL_SLOT_COUNT = 6;
const CURSOR_HELP_HEARTBEAT_INTERVAL_MS = 30_000;
const CURSOR_HELP_HEARTBEAT_BACKOFF_MS = 60_000;
const CURSOR_HELP_HEARTBEAT_RECOVERY_RETRY_MS = 500;
const encoder = new TextEncoder();
const CONTENT_SCRIPT_FILE = "assets/cursor-help-content.js";
const PAGE_HOOK_SCRIPT_FILE = "assets/cursor-help-page-hook.js";
const CURSOR_HELP_SESSION_SLOT_STORAGE_KEY = "cursor_help_web.session_slots";
const CURSOR_HELP_POOL_STORAGE_KEY = "cursor_help_web.pool.v1";
const CURSOR_HELP_CONTAINER_WIDTH = 1280;
const CURSOR_HELP_CONTAINER_HEIGHT = 900;
const CURSOR_HELP_WINDOW_REBUILD_COOLDOWN_MS = 15_000;
const AUTOSCALE_EXPAND_COOLDOWN_MS = 10_000;
const AUTOSCALE_SHRINK_COOLDOWN_MS = 60_000;
const AUTOSCALE_IDLE_THRESHOLD_MS = 120_000;
const HOSTED_CHAT_RESPONSE_CONTENT_TYPE = "application/x-browser-brain-loop-hosted-chat+jsonl";
let cursorHelpSlotLifecycleBoundTabs: typeof chrome.tabs | null = null;
let cursorHelpSlotLifecycleBoundWindows: typeof chrome.windows | null = null;
let cursorHelpHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let cursorHelpHeartbeatInFlight = false;
let cursorHelpHeartbeatLastAt = 0;
let cursorHelpHeartbeatLastDelayMs = 0;
let cursorHelpHeartbeatLastReason = "";
let lastAutoExpandAt = 0;
let lastAutoShrinkAt = 0;
let lastAutoExpandReason = "";
let lastAutoShrinkReason = "";

function isCursorHelpHeartbeatAutoSchedulingDisabledForTests(): boolean {
  return Boolean(
    (globalThis as typeof globalThis & {
      __BRAIN_TEST_DISABLE_CURSOR_HELP_HEARTBEAT__?: boolean;
    }).__BRAIN_TEST_DISABLE_CURSOR_HELP_HEARTBEAT__,
  );
}

export function __resetCursorHelpWebProviderTestState(): void {
  if (cursorHelpHeartbeatTimer) {
    clearTimeout(cursorHelpHeartbeatTimer);
    cursorHelpHeartbeatTimer = null;
  }
  cursorHelpHeartbeatInFlight = false;
  cursorHelpHeartbeatLastAt = 0;
  cursorHelpHeartbeatLastDelayMs = 0;
  cursorHelpHeartbeatLastReason = "";
  ACTIVE_BY_REQUEST_ID.clear();
  ACTIVE_REQUEST_ID_BY_SLOT.clear();
  ACTIVE_REQUEST_ID_BY_TAB.clear();
  ACTIVE_REQUEST_ID_BY_SESSION_LANE.clear();
  PREFERRED_SLOT_ID_BY_SESSION.clear();
  PREFERRED_SLOT_ID_BY_CONVERSATION.clear();
  LAST_CONVERSATION_KEY_BY_SESSION.clear();
  cursorHelpSlotLifecycleBoundTabs = null;
  cursorHelpSlotLifecycleBoundWindows = null;
  lastAutoExpandAt = 0;
  lastAutoShrinkAt = 0;
  lastAutoExpandReason = "";
  lastAutoShrinkReason = "";
}

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

function nowMs(): number {
  return Date.now();
}

function randomSlotId(): string {
  return `cursor-slot-${crypto.randomUUID()}`;
}

function normalizePoolSlotCount(raw: unknown): number {
  const count = Number(raw);
  if (!Number.isInteger(count)) return DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT;
  return Math.min(
    MAX_CURSOR_HELP_POOL_SLOT_COUNT,
    Math.max(MIN_CURSOR_HELP_POOL_SLOT_COUNT, count),
  );
}

function readRequestedPoolSlotCount(input: LlmProviderSendInput): number {
  return normalizePoolSlotCount(
    toRecord(input.route.providerOptions).slotCount,
  );
}

/**
 * Asymmetric lane conflict rules:
 * - same-lane-busy: only one execution per (session, lane) pair at a time.
 * - Any non-title lane must wait for an active title lane (title is fast & blocking avoids
 *   concurrent model hits on the same session).
 * - title must wait for any other active lane (title generation depends on the conversation
 *   state produced by the primary/auxiliary run, so it must not overlap).
 * - Two different non-title lanes (e.g. primary + auxiliary) are allowed in parallel:
 *   they write to independent conversation branches and don't conflict.
 */
function resolveSessionLaneConflict(
  sessionId: string,
  lane: LlmProviderExecutionLane,
): {
  kind: "none" | "same-lane-busy" | "lane-rule-reject";
  reason: string;
  message?: string;
} {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    return { kind: "none", reason: "missing-session" };
  }

  const activeEntries = Array.from(ACTIVE_BY_REQUEST_ID.values()).filter(
    (entry) => !entry.closed && entry.sessionId === normalizedSessionId,
  );
  if (activeEntries.length <= 0) {
    return { kind: "none", reason: "no-active-session-lanes" };
  }

  const sameLane = activeEntries.find((entry) => entry.lane === lane);
  if (sameLane) {
    return {
      kind: "same-lane-busy",
      reason: `same-lane:${lane}`,
      message: `会话 ${normalizedSessionId} 已有执行中的 ${lane} 网页 provider 请求`,
    };
  }

  const activeTitle = activeEntries.find((entry) => entry.lane === "title");
  if (activeTitle) {
    return {
      kind: "lane-rule-reject",
      reason: `${lane}-waits-for:title`,
      message: `会话 ${normalizedSessionId} 的 ${lane} lane 需等待 title 完成后再执行`,
    };
  }

  if (lane === "title") {
    const blocking = activeEntries[0];
    return {
      kind: "lane-rule-reject",
      reason: `title-waits-for:${blocking.lane}`,
      message: `会话 ${normalizedSessionId} 的 title lane 需等待 ${blocking.lane} 完成后再执行`,
    };
  }

  return {
    kind: "none",
    reason: "parallel-allowed",
  };
}

function isCursorHelpUrl(raw: unknown): boolean {
  return String(raw || "").startsWith(CURSOR_HELP_URL);
}

function cloneSlotRecord(slot: CursorHelpSlotRecord): CursorHelpSlotRecord {
  return {
    ...slot,
  };
}

function normalizeSlotRecord(value: unknown): CursorHelpSlotRecord | null {
  const row = toRecord(value);
  const slotId = String(row.slotId || "").trim();
  const tabId = Number(row.tabId);
  if (!slotId || !Number.isInteger(tabId) || tabId <= 0) return null;
  const lanePreference =
    String(row.lanePreference || "").trim() === "primary"
      ? "primary"
      : "auxiliary";
  const statusText = String(row.status || "").trim();
  const status: CursorHelpSlotRecord["status"] =
    statusText === "warming" ||
    statusText === "idle" ||
    statusText === "busy" ||
    statusText === "recovering" ||
    statusText === "stale" ||
    statusText === "error"
      ? (statusText as CursorHelpSlotRecord["status"])
      : "cold";
  const windowId = Number(row.windowId);
  return {
    slotId,
    tabId,
    windowId: Number.isInteger(windowId) && windowId > 0 ? windowId : undefined,
    lanePreference,
    status,
    lastKnownUrl: String(row.lastKnownUrl || ""),
    lastReadyAt: Math.max(0, Number(row.lastReadyAt || 0)),
    lastUsedAt: Math.max(0, Number(row.lastUsedAt || 0)),
    lastHealthCheckedAt: Math.max(0, Number(row.lastHealthCheckedAt || 0)),
    lastHealthReason: String(row.lastHealthReason || "").trim() || undefined,
    recoveryAttemptCount: Math.max(0, Number(row.recoveryAttemptCount || 0)),
    lastRecoveryReason: String(row.lastRecoveryReason || "").trim() || undefined,
    lastError: String(row.lastError || "").trim() || undefined,
  };
}

function normalizePoolState(value: unknown): CursorHelpPoolState {
  const row = toRecord(value);
  const slots = Array.isArray(row.slots)
    ? row.slots
        .map((item) => normalizeSlotRecord(item))
        .filter((item): item is CursorHelpSlotRecord => Boolean(item))
    : [];
  const windowId = Number(row.windowId);
  const windowModeText = String(row.windowMode || "").trim();
  return {
    version: 1,
    windowId: Number.isInteger(windowId) && windowId > 0 ? windowId : undefined,
    slots,
    windowMode:
      windowModeText === "external-tabs" || windowModeText === "pool-window"
        ? (windowModeText as CursorHelpPoolState["windowMode"])
        : "none",
    windowRecoveryCooldownUntil: Math.max(0, Number(row.windowRecoveryCooldownUntil || 0)) || undefined,
    lastWindowEvent: String(row.lastWindowEvent || "").trim() || undefined,
    lastWindowEventAt: Math.max(0, Number(row.lastWindowEventAt || 0)),
    lastWindowEventReason: String(row.lastWindowEventReason || "").trim() || undefined,
    updatedAt: Math.max(0, Number(row.updatedAt || 0)),
  };
}

async function loadCursorHelpPoolState(): Promise<CursorHelpPoolState> {
  const stored = await chrome.storage.local
    .get(CURSOR_HELP_POOL_STORAGE_KEY)
    .catch(() => null);
  return normalizePoolState(stored?.[CURSOR_HELP_POOL_STORAGE_KEY]);
}

async function persistCursorHelpPoolState(
  state: CursorHelpPoolState,
): Promise<void> {
  await chrome.storage.local
    .set({
      [CURSOR_HELP_POOL_STORAGE_KEY]: {
        ...state,
        slots: state.slots.map((slot) => cloneSlotRecord(slot)),
      },
    })
    .catch(() => {
      // noop
    });
}

async function saveCursorHelpPoolState(
  state: CursorHelpPoolState,
): Promise<CursorHelpPoolState> {
  const next: CursorHelpPoolState = {
    version: 1,
    windowId: state.windowId,
    slots: state.slots.map((slot) => cloneSlotRecord(slot)),
    windowMode: state.windowMode || "none",
    windowRecoveryCooldownUntil: state.windowRecoveryCooldownUntil,
    lastWindowEvent: state.lastWindowEvent,
    lastWindowEventAt: Math.max(0, Number(state.lastWindowEventAt || 0)),
    lastWindowEventReason: state.lastWindowEventReason,
    updatedAt: nowMs(),
  };
  await persistCursorHelpPoolState(next);
  return next;
}

async function patchCursorHelpSlotState(
  slotId: string,
  patch: Partial<CursorHelpSlotRecord>,
): Promise<void> {
  const normalizedSlotId = String(slotId || "").trim();
  if (!normalizedSlotId) return;
  const current = await loadCursorHelpPoolState();
  current.slots = current.slots.map((slot) =>
    slot.slotId === normalizedSlotId
      ? {
          ...slot,
          ...patch,
        }
      : slot,
  );
  await saveCursorHelpPoolState(current);
}

function clearSlotPreferences(slotId: string): void {
  const normalizedSlotId = String(slotId || "").trim();
  if (!normalizedSlotId) return;
  const removedConversationKeys = new Set<string>();
  for (const [sessionId, preferredSlotId] of PREFERRED_SLOT_ID_BY_SESSION) {
    if (preferredSlotId === normalizedSlotId) {
      PREFERRED_SLOT_ID_BY_SESSION.delete(sessionId);
    }
  }
  for (const [conversationKey, preferredSlotId] of PREFERRED_SLOT_ID_BY_CONVERSATION) {
    if (preferredSlotId === normalizedSlotId) {
      removedConversationKeys.add(conversationKey);
      PREFERRED_SLOT_ID_BY_CONVERSATION.delete(conversationKey);
    }
  }
  for (const [sessionId, conversationKey] of LAST_CONVERSATION_KEY_BY_SESSION) {
    if (removedConversationKeys.has(conversationKey)) {
      LAST_CONVERSATION_KEY_BY_SESSION.delete(sessionId);
    }
  }
}

export function clearSessionPreferences(sessionId: string): void {
  const conversationKey = LAST_CONVERSATION_KEY_BY_SESSION.get(sessionId);
  if (conversationKey) {
    PREFERRED_SLOT_ID_BY_CONVERSATION.delete(conversationKey);
    LAST_CONVERSATION_KEY_BY_SESSION.delete(sessionId);
  }
  PREFERRED_SLOT_ID_BY_SESSION.delete(sessionId);
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
    `stripCtl=${Number(debug.strippedNativeControlMessageCount || 0)}`,
    `user=${debug.userPromptInjected === true ? "1" : "0"}`,
    `promptHash=${String(debug.compiledPromptHash || "").trim() || "-"}`,
    `promptLen=${Number(debug.compiledPromptLength || 0)}`,
    `origLen=${Number(debug.originalTargetLength || 0)}`,
    `nextLen=${Number(debug.rewrittenTargetLength || 0)}`
  ].join(" ");
}

function enqueueHostedEvent(entry: PendingExecution, event: HostedChatTransportEvent): void {
  if (entry.closed) return;
  const chunk = encoder.encode(serializeHostedChatTransportEvent(event));
  if (entry.controller) {
    entry.controller.enqueue(chunk);
    return;
  }
  entry.queue.push(chunk);
}

function releaseExecution(entry: PendingExecution): boolean {
  if (entry.closed) return false;
  entry.closed = true;
  entry.queue.length = 0;
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    entry.timeoutHandle = null;
  }
  ACTIVE_BY_REQUEST_ID.delete(entry.requestId);
  ACTIVE_REQUEST_ID_BY_SLOT.delete(entry.slotId);
  ACTIVE_REQUEST_ID_BY_TAB.delete(entry.tabId);
  ACTIVE_REQUEST_ID_BY_SESSION_LANE.delete(
    buildSessionLaneKey(entry.sessionId, entry.lane),
  );
  return true;
}

function closeExecution(entry: PendingExecution): void {
  if (!releaseExecution(entry)) return;
  void loadCursorHelpPoolState().then((poolState) => {
    const currentSlot = poolState.slots.find((s) => s.slotId === entry.slotId);
    if (currentSlot?.status === "recovering") return;
    return patchCursorHelpSlotState(entry.slotId, {
      status: "idle",
      lastUsedAt: nowMs(),
      lastError: "",
      lastReadyAt: Math.max(entry.lastEventAt, entry.createdAt),
    });
  }).catch((err) => {
    console.warn(`[web-chat-executor] closeExecution: patchSlotState(idle) failed for slot=${entry.slotId}`, err);
  });
  if (entry.controller) {
    entry.controller.close();
  }
}

function failExecution(entry: PendingExecution, error: string): void {
  if (!releaseExecution(entry)) return;
  if (entry.startedAt === null) {
    void patchCursorHelpSlotState(entry.slotId, {
      status: "stale",
      lastUsedAt: nowMs(),
      lastError: error,
    }).catch((patchErr) => {
      console.warn(`[web-chat-executor] failExecution: patchSlotState(stale) failed for slot=${entry.slotId}`, patchErr);
    });
  } else {
    void patchCursorHelpSlotState(entry.slotId, {
      status: "error",
      lastUsedAt: nowMs(),
      lastError: error,
    }).catch((patchErr) => {
      console.warn(`[web-chat-executor] failExecution: patchSlotState(error) failed for slot=${entry.slotId}`, patchErr);
    });
  }
  if (entry.controller) {
    const err = new Error(error) as Error & { code?: string; retryable?: boolean };
    err.code = "E_HOSTED_CHAT_EXECUTION";
    err.retryable = true;
    entry.controller.error(err);
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

function clearStaleExecution(slotId: string, tabId: number): void {
  const requestIds = new Set<string>();
  const bySlot = ACTIVE_REQUEST_ID_BY_SLOT.get(slotId);
  const byTab = ACTIVE_REQUEST_ID_BY_TAB.get(tabId);
  if (bySlot) requestIds.add(bySlot);
  if (byTab) requestIds.add(byTab);
  for (const requestId of requestIds) {
    const entry = ACTIVE_BY_REQUEST_ID.get(requestId);
    if (!entry) {
      ACTIVE_REQUEST_ID_BY_SLOT.delete(slotId);
      ACTIVE_REQUEST_ID_BY_TAB.delete(tabId);
      continue;
    }
    if (entry.startedAt === null && Date.now() - entry.createdAt >= EXECUTION_BOOT_TIMEOUT_MS) {
      failExecution(entry, "网页 provider 请求启动超时，已自动回收旧执行");
      continue;
    }
    if (Date.now() - entry.lastEventAt < EXECUTION_STALE_MS) continue;
    failExecution(entry, "网页 provider 请求已超时，已自动回收旧执行");
  }
}

function reapStaleExecutionsForSlots(
  slots: CursorHelpSlotRecord[],
): void {
  for (const slot of slots) {
    clearStaleExecution(slot.slotId, slot.tabId);
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

async function waitForCursorHelpInspectReady(
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

function canCursorHelpSlotBootExecute(
  inspect: CursorHelpInspectResult | null,
): boolean {
  return Boolean(
    inspect &&
      inspect.pageHookReady &&
      inspect.fetchHookReady &&
      !inspect.runtimeMismatch,
  );
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

async function clearLegacySessionSlots(): Promise<void> {
  await chrome.storage.local
    .remove(CURSOR_HELP_SESSION_SLOT_STORAGE_KEY)
    .catch(() => {
      // noop
    });
}

async function isCursorHelpWindowAlive(
  windowId: number | undefined,
): Promise<boolean> {
  if (!Number.isInteger(windowId) || Number(windowId) <= 0) return false;
  const found = await chrome.windows.get(Number(windowId)).catch(() => null);
  return Boolean(found?.id);
}

async function minimizeCursorHelpWindow(
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

async function markCursorHelpTabStable(tabId: number): Promise<void> {
  await chrome.tabs
    .update(tabId, {
      autoDiscardable: false,
    })
    .catch(() => {
      // noop
    });
}

function buildCursorHelpSlotRecord(
  tab: chrome.tabs.Tab,
  lanePreference: "primary" | "auxiliary",
  existingSlotId?: string,
): CursorHelpSlotRecord {
  return {
    slotId: existingSlotId || randomSlotId(),
    tabId: Number(tab.id),
    windowId:
      typeof tab.windowId === "number" && tab.windowId > 0
        ? tab.windowId
        : undefined,
    lanePreference,
    status: "warming",
    lastKnownUrl: String(tab.url || ""),
    lastReadyAt: 0,
    lastUsedAt: 0,
    lastHealthCheckedAt: 0,
    lastHealthReason: undefined,
    recoveryAttemptCount: 0,
    lastRecoveryReason: undefined,
    lastError: undefined,
  };
}

function getRecoveryBudget(reason: string): number {
  const normalized = String(reason || "").trim();
  if (normalized === "page-not-ready") return 3;
  if (normalized === "inspect-failed") return 2;
  if (normalized === "tab-missing") return 2;
  return 1;
}

function buildSlotHealthSnapshot(
  status: CursorHelpSlotRecord["status"],
  reason: string,
  error = "",
): Pick<CursorHelpSlotRecord, "status" | "lastHealthCheckedAt" | "lastHealthReason" | "lastError"> {
  return {
    status,
    lastHealthCheckedAt: nowMs(),
    lastHealthReason: String(reason || "").trim() || undefined,
    lastError: String(error || "").trim() || undefined,
  };
}

function classifyInspectHealth(
  inspect: CursorHelpInspectResult | null,
): Pick<CursorHelpSlotRecord, "status" | "lastHealthReason" | "lastError"> {
  if (!inspect) {
    return {
      status: "stale",
      lastHealthReason: "inspect-failed",
      lastError: "未找到可用的 Cursor Help 页面。请确认页面已完成加载。",
    };
  }
  if (inspect.runtimeMismatch) {
    return {
      status: "error",
      lastHealthReason: "runtime-mismatch",
      lastError: formatInspectFailure(inspect),
    };
  }
  if (!canCursorHelpSlotBootExecute(inspect)) {
    return {
      status: "warming",
      lastHealthReason: "page-not-ready",
      lastError: formatInspectFailure(inspect),
    };
  }
  return {
    status: "idle",
    lastHealthReason: "ready",
    lastError: "",
  };
}

function resolveHeartbeatDelay(debugState: CursorHelpPoolDebugView): {
  delayMs: number;
  reason: string;
} {
  const summary = toRecord(debugState.summary);
  const errorCount = Number(summary.errorCount || 0);
  if (summary.shouldRebuildWindow || summary.requiresAttention || errorCount > 0) {
    return {
      delayMs: CURSOR_HELP_HEARTBEAT_BACKOFF_MS,
      reason: "attention",
    };
  }
  return {
    delayMs: CURSOR_HELP_HEARTBEAT_INTERVAL_MS,
    reason: "steady",
  };
}

function scheduleCursorHelpPoolHeartbeat(delayMs = CURSOR_HELP_HEARTBEAT_INTERVAL_MS): void {
  if (cursorHelpHeartbeatTimer) return;
  cursorHelpHeartbeatLastDelayMs = delayMs;
  if (isCursorHelpHeartbeatAutoSchedulingDisabledForTests()) {
    return;
  }
  cursorHelpHeartbeatTimer = setTimeout(async () => {
    cursorHelpHeartbeatTimer = null;
    if (cursorHelpHeartbeatInFlight) {
      scheduleCursorHelpPoolHeartbeat(delayMs);
      return;
    }
    cursorHelpHeartbeatInFlight = true;
    try {
      const debugState = await runCursorHelpPoolHeartbeat();
      const next = resolveHeartbeatDelay(debugState);
      cursorHelpHeartbeatLastReason = `scheduled:${next.reason}`;
      scheduleCursorHelpPoolHeartbeat(next.delayMs);
    } catch {
      cursorHelpHeartbeatLastReason = "scheduled:error";
      scheduleCursorHelpPoolHeartbeat(CURSOR_HELP_HEARTBEAT_BACKOFF_MS);
    } finally {
      cursorHelpHeartbeatInFlight = false;
    }
  }, delayMs);
  const nodeTimer = cursorHelpHeartbeatTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
  if (typeof nodeTimer?.unref === "function") {
    nodeTimer.unref();
  }
}

async function tryAdoptExistingCursorHelpSlots(
  slotCount: number,
): Promise<CursorHelpPoolState | null> {
  const desiredSlotCount = normalizePoolSlotCount(slotCount);
  const existingTabs = await chrome.tabs
    .query({ url: [...CURSOR_TAB_PATTERNS] })
    .catch(() => [] as chrome.tabs.Tab[]);
  const adoptedSlots: CursorHelpSlotRecord[] = [];

  for (const tab of existingTabs) {
    if (!tab?.id) continue;
    await markCursorHelpTabStable(tab.id);
    try {
      await waitForCursorHelpTabReady(tab.id, 5_000);
    } catch {
      continue;
    }
    const inspect = await waitForCursorHelpInspectReady(tab.id, 8_000);
    if (!canCursorHelpSlotBootExecute(inspect)) continue;
    adoptedSlots.push({
      slotId: randomSlotId(),
      tabId: tab.id,
      windowId:
        typeof tab.windowId === "number" && tab.windowId > 0
          ? tab.windowId
          : undefined,
      lanePreference: adoptedSlots.length === 0 ? "primary" : "auxiliary",
      status: "idle",
      lastKnownUrl: String(inspect.url || tab.url || CURSOR_HELP_URL),
      lastReadyAt: nowMs(),
      lastUsedAt: 0,
      lastHealthCheckedAt: nowMs(),
      lastHealthReason: "ready",
      recoveryAttemptCount: 0,
      lastRecoveryReason: undefined,
      lastError: undefined,
    });
    if (adoptedSlots.length >= Math.min(desiredSlotCount, 1)) break;
  }

  if (adoptedSlots.length <= 0) return null;
  await clearLegacySessionSlots();
  return await saveCursorHelpPoolState(withWindowEvent({
    version: 1,
    windowId: undefined,
    slots: sortSlotsForDisplay(adoptedSlots),
    windowMode: "external-tabs",
    updatedAt: nowMs(),
  }, "adopt_existing_tabs", {
    mode: "external-tabs",
    reason: `adopted=${adoptedSlots.length}`,
  }));
}

async function createCursorHelpPoolWindow(
  slotCount: number,
): Promise<CursorHelpPoolState> {
  const desiredSlotCount = normalizePoolSlotCount(slotCount);
  const adopted = await tryAdoptExistingCursorHelpSlots(desiredSlotCount);
  if (adopted) {
    return adopted;
  }
  const createdWindow = await chrome.windows
    .create({
      url: CURSOR_HELP_URL,
      focused: false,
      type: "popup",
      width: CURSOR_HELP_CONTAINER_WIDTH,
      height: CURSOR_HELP_CONTAINER_HEIGHT,
    })
    .catch(async () => {
      return chrome.windows.create({
        url: CURSOR_HELP_URL,
        focused: false,
        width: CURSOR_HELP_CONTAINER_WIDTH,
        height: CURSOR_HELP_CONTAINER_HEIGHT,
      });
    });
  const firstTab = Array.isArray(createdWindow?.tabs)
    ? createdWindow.tabs[0]
    : null;
  if (!firstTab?.id || !createdWindow?.id) {
    throw new Error("cursor_help_web 无法打开专用 Help 窗口");
  }

  const slots: CursorHelpSlotRecord[] = [];
  await markCursorHelpTabStable(firstTab.id);
  const firstSlot = buildCursorHelpSlotRecord(firstTab, "primary");
  const firstInspect = await waitForCursorHelpInspectReady(firstTab.id, 8_000);
  if (canCursorHelpSlotBootExecute(firstInspect)) {
    firstSlot.status = "idle";
    firstSlot.lastReadyAt = nowMs();
    firstSlot.lastHealthCheckedAt = nowMs();
    firstSlot.lastHealthReason = "ready";
    firstSlot.lastError = undefined;
  }
  slots.push(firstSlot);

  for (let index = 1; index < desiredSlotCount; index += 1) {
    const tab = await chrome.tabs.create({
      windowId: createdWindow.id,
      url: CURSOR_HELP_URL,
      active: false,
    });
    if (!tab?.id) continue;
    await markCursorHelpTabStable(tab.id);
    const slot = buildCursorHelpSlotRecord(tab, "auxiliary");
    const inspect = await waitForCursorHelpInspectReady(tab.id, 8_000);
    if (canCursorHelpSlotBootExecute(inspect)) {
      slot.status = "idle";
      slot.lastReadyAt = nowMs();
      slot.lastHealthCheckedAt = nowMs();
      slot.lastHealthReason = "ready";
      slot.lastError = undefined;
    }
    slots.push(slot);
  }

  const createdWindowType = String(createdWindow.type || "").trim() || "unknown";
  const minimized = await minimizeCursorHelpWindow(createdWindow.id);
  await clearLegacySessionSlots();
  return await saveCursorHelpPoolState(withWindowEvent({
    version: 1,
    windowId: createdWindow.id,
    slots: sortSlotsForDisplay(slots),
    windowMode: "pool-window",
    updatedAt: nowMs(),
  }, "create_pool_window", {
    mode: "pool-window",
    reason: `slots=${slots.length} type=${createdWindowType} minimized=${minimized ? 1 : 0}`,
  }));
}

async function readLiveCursorHelpSlot(
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

async function createAdditionalPoolSlot(
  windowId: number,
  lanePreference: "primary" | "auxiliary",
  existingSlotId?: string,
): Promise<CursorHelpSlotRecord | null> {
  const tab = await chrome.tabs
    .create({
      windowId,
      url: CURSOR_HELP_URL,
      active: false,
    })
    .catch(() => null);
  if (!tab?.id) return null;
  await markCursorHelpTabStable(tab.id);
  return buildCursorHelpSlotRecord(tab, lanePreference, existingSlotId);
}

function hasSlotAffinity(slotId: string): boolean {
  for (const preferredSlotId of PREFERRED_SLOT_ID_BY_SESSION.values()) {
    if (preferredSlotId === slotId) return true;
  }
  for (const preferredSlotId of PREFERRED_SLOT_ID_BY_CONVERSATION.values()) {
    if (preferredSlotId === slotId) return true;
  }
  return false;
}

async function tryAutoExpandPool(
  state: CursorHelpPoolState,
): Promise<CursorHelpSlotRecord | null> {
  if (state.slots.length >= MAX_CURSOR_HELP_POOL_SLOT_COUNT) return null;
  if (nowMs() - lastAutoExpandAt < AUTOSCALE_EXPAND_COOLDOWN_MS) return null;
  const windowId = state.windowId;
  if (!windowId) return null;
  const windowAlive = await isCursorHelpWindowAlive(windowId);
  if (!windowAlive) return null;
  const newSlot = await createAdditionalPoolSlot(windowId, "auxiliary");
  if (!newSlot) return null;
  const inspect = await waitForCursorHelpInspectReady(newSlot.tabId, 8_000).catch(() => null);
  if (inspect && canCursorHelpSlotBootExecute(inspect)) {
    newSlot.status = "idle";
    newSlot.lastReadyAt = nowMs();
    newSlot.lastHealthCheckedAt = nowMs();
    newSlot.lastHealthReason = "ready";
    newSlot.lastError = undefined;
  }
  state.slots.push(newSlot);
  const reason = `slots=${state.slots.length - 1}→${state.slots.length}`;
  await saveCursorHelpPoolState(withWindowEvent({
    ...state,
    slots: sortSlotsForDisplay(state.slots),
    updatedAt: nowMs(),
  }, "autoscale_expand", {
    mode: state.windowMode || "pool-window",
    reason,
  }));
  lastAutoExpandAt = nowMs();
  lastAutoExpandReason = reason;
  return newSlot;
}

async function tryAutoShrinkPool(
  state: CursorHelpPoolState,
): Promise<boolean> {
  if (state.slots.length <= MIN_CURSOR_HELP_POOL_SLOT_COUNT) return false;
  if (nowMs() - lastAutoShrinkAt < AUTOSCALE_SHRINK_COOLDOWN_MS) return false;
  const now = nowMs();
  const shrinkCandidates = state.slots.filter((slot) => {
    if (slot.status !== "idle") return false;
    if (ACTIVE_REQUEST_ID_BY_SLOT.has(slot.slotId)) return false;
    if (hasSlotAffinity(slot.slotId)) return false;
    const lastActive = slot.lastUsedAt > 0 ? slot.lastUsedAt : (slot.lastReadyAt || 0);
    const idleDuration = now - lastActive;
    return idleDuration >= AUTOSCALE_IDLE_THRESHOLD_MS;
  });
  if (shrinkCandidates.length <= 0) return false;
  shrinkCandidates.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  const target = shrinkCandidates[0];
  closeActiveRequestForSlot(target.slotId, "autoscale_shrink");
  clearSlotPreferences(target.slotId);
  await chrome.tabs.remove(target.tabId).catch(() => {});
  state.slots = state.slots.filter((s) => s.slotId !== target.slotId);
  const reason = `slots=${state.slots.length + 1}→${state.slots.length} removed=${target.slotId}`;
  await saveCursorHelpPoolState(withWindowEvent({
    ...state,
    slots: sortSlotsForDisplay(state.slots),
    updatedAt: nowMs(),
  }, "autoscale_shrink", {
    mode: state.windowMode || "pool-window",
    reason,
  }));
  lastAutoShrinkAt = nowMs();
  lastAutoShrinkReason = reason;
  return true;
}

async function collectCursorHelpTabDecisionTrace(
  state: CursorHelpPoolState,
): Promise<{
  liveCursorHelpTabCount: number;
  managedCursorHelpTabCount: number;
  unmanagedCursorHelpTabCount: number;
  entries: Array<{
    tabId: number;
    windowId: number;
    url: string;
    status: string;
    managed: boolean;
    decision: "managed" | "candidate";
    reason: string;
  }>;
}> {
  const liveTabs = await chrome.tabs
    .query({ url: [...CURSOR_TAB_PATTERNS] })
    .catch(() => [] as chrome.tabs.Tab[]);
  const managedTabIds = new Set(
    state.slots
      .map((slot) => Number(slot.tabId || 0))
      .filter((tabId) => Number.isInteger(tabId) && tabId > 0),
  );
  let managedCursorHelpTabCount = 0;
  let unmanagedCursorHelpTabCount = 0;
  const entries: Array<{
    tabId: number;
    windowId: number;
    url: string;
    status: string;
    managed: boolean;
    decision: "managed" | "candidate";
    reason: string;
  }> = [];

  for (const tab of liveTabs) {
    if (!tab?.id) continue;
    if (managedTabIds.has(tab.id)) {
      managedCursorHelpTabCount += 1;
      entries.push({
        tabId: tab.id,
        windowId: Number(tab.windowId || 0),
        url: String(tab.url || ""),
        status: String(tab.status || ""),
        managed: true,
        decision: "managed",
        reason: "tracked-slot",
      });
    } else {
      unmanagedCursorHelpTabCount += 1;
      entries.push({
        tabId: tab.id,
        windowId: Number(tab.windowId || 0),
        url: String(tab.url || ""),
        status: String(tab.status || ""),
        managed: false,
        decision: "candidate",
        reason: "unmanaged-live-tab",
      });
    }
  }

  return {
    liveCursorHelpTabCount: liveTabs.length,
    managedCursorHelpTabCount,
    unmanagedCursorHelpTabCount,
    entries,
  };
}

async function attemptCursorHelpSlotRecovery(
  slot: CursorHelpSlotRecord,
): Promise<void> {
  if (!slot.windowId || !Number.isInteger(slot.windowId) || slot.windowId <= 0) return;
  const windowAlive = await isCursorHelpWindowAlive(slot.windowId);
  if (!windowAlive) return;
  const nextAttemptCount = Number(slot.recoveryAttemptCount || 0) + 1;
  const recoveryReason = "tab-missing";
  if (nextAttemptCount > getRecoveryBudget(recoveryReason)) {
    await patchCursorHelpSlotState(slot.slotId, {
      ...buildSlotHealthSnapshot("error", "recover-budget-exhausted", `recovery budget exhausted for ${recoveryReason}`),
      recoveryAttemptCount: nextAttemptCount,
      lastRecoveryReason: recoveryReason,
    });
    return;
  }
  await patchCursorHelpSlotState(slot.slotId, {
    ...buildSlotHealthSnapshot("recovering", "recovering", "auto-recovering slot"),
    recoveryAttemptCount: nextAttemptCount,
    lastRecoveryReason: recoveryReason,
  });
  const replacement = await createAdditionalPoolSlot(
    slot.windowId,
    slot.lanePreference,
    slot.slotId,
  );
  if (!replacement) {
    await patchCursorHelpSlotState(slot.slotId, {
      ...buildSlotHealthSnapshot("error", "recover-failed", "slot recovery failed"),
    });
    return;
  }
  await patchCursorHelpSlotState(slot.slotId, {
    tabId: replacement.tabId,
    windowId: replacement.windowId,
    lanePreference: replacement.lanePreference,
    lastKnownUrl: replacement.lastKnownUrl,
    ...buildSlotHealthSnapshot("recovering", "recovering", "auto-recovering slot"),
    recoveryAttemptCount: nextAttemptCount,
    lastRecoveryReason: recoveryReason,
  });
  await ensureCursorHelpSlotUsable({
    ...slot,
    ...replacement,
    status: "recovering",
  }).catch(() => null);
}

async function attemptCursorHelpSlotSoftRecovery(
  slot: CursorHelpSlotRecord,
): Promise<void> {
  const recoveryReason = String(slot.lastHealthReason || "").trim() || "inspect-failed";
  const nextAttemptCount = Number(slot.recoveryAttemptCount || 0) + 1;
  if (nextAttemptCount > getRecoveryBudget(recoveryReason)) {
    await patchCursorHelpSlotState(slot.slotId, {
      ...buildSlotHealthSnapshot("error", "recover-budget-exhausted", `recovery budget exhausted for ${recoveryReason}`),
      recoveryAttemptCount: nextAttemptCount,
      lastRecoveryReason: recoveryReason,
    });
    return;
  }
  await patchCursorHelpSlotState(slot.slotId, {
    ...buildSlotHealthSnapshot("recovering", "recovering", "retrying slot health"),
    recoveryAttemptCount: nextAttemptCount,
    lastRecoveryReason: recoveryReason,
  });
  await injectCursorHelpScripts(slot.tabId).catch(() => {
    // noop
  });
  await new Promise((resolve) => setTimeout(resolve, CURSOR_HELP_HEARTBEAT_RECOVERY_RETRY_MS));
  await ensureCursorHelpSlotUsable({
    ...slot,
    status: "recovering",
  }).catch(() => null);
}

let reconcilePoolMutex: Promise<CursorHelpPoolState> | null = null;

async function reconcileCursorHelpPoolState(
  slotCount: number,
  options: {
    allowAutoRebuildAfterRemoval?: boolean;
  } = {},
): Promise<CursorHelpPoolState> {
  while (reconcilePoolMutex) {
    await reconcilePoolMutex.catch(() => {});
  }
  const task = reconcileCursorHelpPoolStateUnsafe(slotCount, options);
  reconcilePoolMutex = task;
  try {
    return await task;
  } finally {
    if (reconcilePoolMutex === task) {
      reconcilePoolMutex = null;
    }
  }
}

async function reconcileCursorHelpPoolStateUnsafe(
  slotCount: number,
  options: {
    allowAutoRebuildAfterRemoval?: boolean;
  } = {},
): Promise<CursorHelpPoolState> {
  const desiredSlotCount = normalizePoolSlotCount(slotCount);
  const current = await loadCursorHelpPoolState();
  const windowAlive = await isCursorHelpWindowAlive(current.windowId);
  let windowId = windowAlive ? current.windowId : undefined;
  let slots = (
    await Promise.all(current.slots.map((slot) => readLiveCursorHelpSlot(slot)))
  ).filter((slot): slot is CursorHelpSlotRecord => Boolean(slot));

  if (!windowId && slots.length > 0) {
    const nextState = await saveCursorHelpPoolState(withWindowEvent({
      version: 1,
      windowId: undefined,
      slots: sortSlotsForDisplay(slots),
      windowMode: "external-tabs",
      windowRecoveryCooldownUntil: undefined,
      updatedAt: nowMs(),
    }, "reuse_external_tabs", {
      mode: "external-tabs",
      reason: `slots=${slots.length}`,
      recoveryCooldownUntil: 0,
    }));
    await clearLegacySessionSlots();
    return nextState;
  }

  if (!windowId && slots.length <= 0 && current.windowMode === "pool-window") {
    const adopted = await tryAdoptExistingCursorHelpSlots(desiredSlotCount);
    if (adopted) {
      return adopted;
    }
  }

  if (!windowId && slots.length <= 0 && current.windowMode === "pool-window") {
    const recovery = resolveMissingPoolWindowRecoveryAction(current, options);
    if (recovery.action === "skip-cooldown") {
      const nextState = await saveCursorHelpPoolState(withWindowEvent({
        ...current,
        windowId: undefined,
        slots: [],
        windowMode: "pool-window",
        updatedAt: nowMs(),
      }, "skip_window_rebuild_cooldown", {
        mode: "pool-window",
        reason: recovery.reason,
        recoveryCooldownUntil: current.windowRecoveryCooldownUntil || 0,
      }));
      await clearLegacySessionSlots();
      return nextState;
    }
    if (recovery.action === "await-manual") {
      const nextState = await saveCursorHelpPoolState(withWindowEvent({
        ...current,
        windowId: undefined,
        slots: [],
        windowMode: "pool-window",
        updatedAt: nowMs(),
      }, "await_manual_rebuild", {
        mode: "pool-window",
        reason: recovery.reason,
      }));
      await clearLegacySessionSlots();
      return nextState;
    }
  }

  if (!windowId) {
    return await createCursorHelpPoolWindow(desiredSlotCount);
  }

  while (slots.length < desiredSlotCount) {
    const lanePreference = slots.length === 0 ? "primary" : "auxiliary";
    const nextSlot = await createAdditionalPoolSlot(windowId, lanePreference);
    if (!nextSlot) break;
    slots.push(nextSlot);
  }

  const nextState = await saveCursorHelpPoolState({
    version: 1,
    windowId,
    slots: sortSlotsForDisplay(slots),
    windowMode: "pool-window",
    updatedAt: nowMs(),
  });
  const liveWindow = await chrome.windows.get(windowId).catch(() => null);
  const liveWindowPolicy = buildCursorHelpWindowPolicyState(nextState, liveWindow);
  if (!liveWindowPolicy.shouldBackgroundWindow) {
    return await saveCursorHelpPoolState(withWindowEvent(nextState, "skip_window_backgrounding", {
      mode: "pool-window",
      reason: liveWindowPolicy.backgroundBlockedReason || `windowId=${windowId}`,
    }));
  }
  const minimized = await minimizeCursorHelpWindow(windowId);
  if (!minimized) {
    return await saveCursorHelpPoolState(withWindowEvent(nextState, "skip_window_backgrounding", {
      mode: "pool-window",
      reason: `windowId=${windowId} minimize-returned-false`,
    }));
  }
  await clearLegacySessionSlots();
  return nextState;
}

async function markCursorHelpSlotBusy(
  slot: CursorHelpSlotRecord,
): Promise<void> {
  await patchCursorHelpSlotState(slot.slotId, {
    status: "busy",
    lastUsedAt: nowMs(),
    lastError: "",
    windowId: slot.windowId,
    lastKnownUrl: slot.lastKnownUrl,
  });
}

async function ensureCursorHelpSlotUsable(
  slot: CursorHelpSlotRecord,
  options: {
    throwOnRuntimeMismatch?: boolean;
  } = {},
): Promise<{ slot: CursorHelpSlotRecord; inspect: CursorHelpInspectResult } | null> {
  const tab = await chrome.tabs.get(slot.tabId).catch(() => null);
  if (!tab?.id || !isCursorHelpUrl(tab.url)) {
    await patchCursorHelpSlotState(slot.slotId, {
      ...buildSlotHealthSnapshot("stale", "tab-missing", "slot tab missing"),
    });
    clearSlotPreferences(slot.slotId);
    return null;
  }
  await markCursorHelpTabStable(tab.id);
  try {
    await waitForCursorHelpTabReady(tab.id);
  } catch (error) {
    await patchCursorHelpSlotState(slot.slotId, {
      ...buildSlotHealthSnapshot(
        "stale",
        "page-not-ready",
        error instanceof Error ? error.message : String(error),
      ),
      windowId: typeof tab.windowId === "number" ? tab.windowId : slot.windowId,
      lastKnownUrl: String(tab.url || slot.lastKnownUrl || ""),
    });
    return null;
  }
  const inspect = await inspectCursorTabEnsured(tab.id);
  const health = classifyInspectHealth(inspect);
  await patchCursorHelpSlotState(slot.slotId, {
    ...buildSlotHealthSnapshot(
      health.status,
      String(health.lastHealthReason || ""),
      String(health.lastError || ""),
    ),
    recoveryAttemptCount: canCursorHelpSlotBootExecute(inspect)
      ? 0
      : slot.recoveryAttemptCount,
    lastRecoveryReason: canCursorHelpSlotBootExecute(inspect)
      ? undefined
      : slot.lastRecoveryReason,
    windowId: typeof tab.windowId === "number" ? tab.windowId : slot.windowId,
    lastKnownUrl: String(inspect?.url || tab.url || slot.lastKnownUrl || ""),
    lastReadyAt: canCursorHelpSlotBootExecute(inspect) ? nowMs() : slot.lastReadyAt,
  });
  if (!canCursorHelpSlotBootExecute(inspect)) {
    if (options.throwOnRuntimeMismatch && inspect?.runtimeMismatch) {
      throw new Error(formatInspectFailure(inspect));
    }
    return null;
  }
  return {
    slot: {
      ...slot,
      windowId: typeof tab.windowId === "number" ? tab.windowId : slot.windowId,
      lastKnownUrl: String(inspect.url || tab.url || slot.lastKnownUrl || ""),
      status: "idle",
      lastReadyAt: nowMs(),
    },
    inspect,
  };
}

function chooseCursorHelpSlot(
  slots: CursorHelpSlotRecord[],
  lane: LlmProviderExecutionLane,
  sessionId: string,
  conversationKey = "",
): CursorHelpSlotRecord | null {
  const preferredSlotIdByConversation = String(
    PREFERRED_SLOT_ID_BY_CONVERSATION.get(conversationKey) || "",
  ).trim();
  const preferredSlotIdBySession = String(
    PREFERRED_SLOT_ID_BY_SESSION.get(sessionId) || "",
  ).trim();
  const lanePreference = toSlotLanePreference(lane);
  const candidates = slots.filter(
    (slot) => !ACTIVE_REQUEST_ID_BY_SLOT.has(slot.slotId),
  );
  if (candidates.length <= 0) return null;
  const sorted = [...candidates].sort((left, right) => {
    const conversationAffinity =
      (left.slotId === preferredSlotIdByConversation ? 0 : 1) -
      (right.slotId === preferredSlotIdByConversation ? 0 : 1);
    if (conversationAffinity !== 0) return conversationAffinity;
    const sessionAffinity =
      (left.slotId === preferredSlotIdBySession ? 0 : 1) -
      (right.slotId === preferredSlotIdBySession ? 0 : 1);
    if (sessionAffinity !== 0) return sessionAffinity;
    const laneDiff =
      (left.lanePreference === lanePreference ? 0 : 1) -
      (right.lanePreference === lanePreference ? 0 : 1);
    if (laneDiff !== 0) return laneDiff;
    return left.lastUsedAt - right.lastUsedAt;
  });
  return sorted[0] || null;
}

function resolveConversationKeyForSession(
  sessionId: string,
  payload: JsonRecord,
): string {
  const explicitConversationKey = String(payload.conversationKey || "").trim();
  if (explicitConversationKey) return explicitConversationKey;
  return String(LAST_CONVERSATION_KEY_BY_SESSION.get(sessionId) || "").trim();
}

async function waitForCursorHelpSlot(
  input: LlmProviderSendInput,
  lane: LlmProviderExecutionLane,
): Promise<{
  sessionId: string;
  slot: CursorHelpSlotRecord;
  inspect: CursorHelpInspectResult;
  conversationKey: string;
}> {
  const sessionId = String(input.sessionId || "").trim() || "default";
  const conversationKey = resolveConversationKeyForSession(
    sessionId,
    toRecord(input.payload),
  );
  const deadline =
    nowMs() + (lane === "primary" ? PRIMARY_SLOT_WAIT_MS : AUXILIARY_SLOT_WAIT_MS);
  const desiredSlotCount = readRequestedPoolSlotCount(input);
  let sawBusyCandidates = false;
  let lastUnavailableReason = "";
  let pollInterval = SLOT_WAIT_POLL_MS;

  while (nowMs() < deadline) {
    const state = await reconcileCursorHelpPoolState(desiredSlotCount, {
      allowAutoRebuildAfterRemoval: true,
    });
    reapStaleExecutionsForSlots(state.slots);
    const chosen = chooseCursorHelpSlot(state.slots, lane, sessionId, conversationKey);
    if (chosen) {
      sawBusyCandidates = false;
      const usable = await ensureCursorHelpSlotUsable(chosen, {
        throwOnRuntimeMismatch: true,
      });
      if (usable) {
        return {
          sessionId,
          slot: usable.slot,
          inspect: usable.inspect,
          conversationKey,
        };
      }
      lastUnavailableReason = String(chosen.lastError || "").trim() || "Cursor Help 页面尚未完成启动";
    } else {
      sawBusyCandidates = state.slots.length > 0;
      if (sawBusyCandidates) {
        const expanded = await tryAutoExpandPool(state);
        if (expanded) {
          const usable = await ensureCursorHelpSlotUsable(expanded, {
            throwOnRuntimeMismatch: true,
          });
          if (usable) {
            return {
              sessionId,
              slot: usable.slot,
              inspect: usable.inspect,
              conversationKey,
            };
          }
        }
      }
      lastUnavailableReason = sawBusyCandidates
        ? "当前所有槽位都有活动中的网页 provider 请求"
        : "暂无可用的 Cursor Help 槽位";
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    pollInterval = Math.min(pollInterval * 1.5, 2000);
  }

  if (sawBusyCandidates) {
    throw new Error(
      lane === "primary"
        ? "Cursor Help 主执行槽位繁忙，请稍后重试。"
        : "Cursor Help 辅助执行槽位繁忙，请稍后重试。",
    );
  }

  const prefix = lane === "primary"
    ? "Cursor Help 主执行槽位未就绪"
    : "Cursor Help 辅助执行槽位未就绪";
  throw new Error(
    lastUnavailableReason ? `${prefix}：${lastUnavailableReason}` : prefix,
  );
}

function closeActiveRequestForSlot(slotId: string, reason: string): void {
  const requestId = ACTIVE_REQUEST_ID_BY_SLOT.get(String(slotId || "").trim());
  if (!requestId) return;
  const entry = ACTIVE_BY_REQUEST_ID.get(requestId);
  if (!entry) {
    ACTIVE_REQUEST_ID_BY_SLOT.delete(String(slotId || "").trim());
    return;
  }
  failExecution(entry, reason);
}

async function removeCursorHelpSlotByTabId(tabId: number): Promise<void> {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const current = await loadCursorHelpPoolState();
  const removedSlots = current.slots.filter((slot) => slot.tabId === tabId);
  if (removedSlots.length <= 0) return;
  for (const slot of removedSlots) {
    closeActiveRequestForSlot(slot.slotId, "Cursor Help 槽位标签页已关闭");
    clearSlotPreferences(slot.slotId);
  }
  current.slots = current.slots.filter((slot) => slot.tabId !== tabId);
  await saveCursorHelpPoolState(current);
}

async function removeCursorHelpSlotsByWindowId(windowId: number): Promise<void> {
  if (!Number.isInteger(windowId) || windowId <= 0) return;
  const current = await loadCursorHelpPoolState();
  const removedSlots = current.slots.filter((slot) => slot.windowId === windowId);
  const removedPrimaryPoolWindow = current.windowId === windowId;
  if (removedSlots.length <= 0 && !removedPrimaryPoolWindow) return;
  for (const slot of removedSlots) {
    closeActiveRequestForSlot(slot.slotId, "Cursor Help 专用窗口已关闭");
    clearSlotPreferences(slot.slotId);
  }
  current.slots = current.slots.filter((slot) => slot.windowId !== windowId);
  if (current.windowId === windowId) {
    current.windowId = undefined;
  }
  const nextState = withWindowEvent(current, "pool_window_removed", {
    mode: removedPrimaryPoolWindow
      ? "pool-window"
      : current.slots.some((slot) => slot.windowId)
        ? current.windowMode
        : "none",
    reason: `windowId=${windowId}`,
    recoveryCooldownUntil: removedPrimaryPoolWindow
      ? nowMs() + CURSOR_HELP_WINDOW_REBUILD_COOLDOWN_MS
      : current.windowRecoveryCooldownUntil || 0,
  });
  await saveCursorHelpPoolState(nextState);
}

function handleTabRemoved(tabId: number): void {
  void removeCursorHelpSlotByTabId(tabId);
}

function handleWindowRemoved(windowId: number): void {
  void removeCursorHelpSlotsByWindowId(windowId);
}

function ensureCursorHelpSlotLifecycle(): void {
  const tabsApi = chrome.tabs;
  if (tabsApi?.onRemoved?.addListener && cursorHelpSlotLifecycleBoundTabs !== tabsApi) {
    if (cursorHelpSlotLifecycleBoundTabs?.onRemoved?.removeListener) {
      cursorHelpSlotLifecycleBoundTabs.onRemoved.removeListener(handleTabRemoved);
    }
    cursorHelpSlotLifecycleBoundTabs = tabsApi;
    tabsApi.onRemoved.addListener(handleTabRemoved);
  }
  const windowsApi = chrome.windows;
  if (
    windowsApi?.onRemoved?.addListener &&
    cursorHelpSlotLifecycleBoundWindows !== windowsApi
  ) {
    if (cursorHelpSlotLifecycleBoundWindows?.onRemoved?.removeListener) {
      cursorHelpSlotLifecycleBoundWindows.onRemoved.removeListener(handleWindowRemoved);
    }
    cursorHelpSlotLifecycleBoundWindows = windowsApi;
    windowsApi.onRemoved.addListener(handleWindowRemoved);
  }
}

export async function ensureCursorHelpPoolReady(
  slotCount = DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT,
): Promise<CursorHelpPoolDebugView> {
  ensureCursorHelpSlotLifecycle();
  const state = await reconcileCursorHelpPoolState(slotCount, {
    allowAutoRebuildAfterRemoval: false,
  });
  for (const slot of state.slots) {
    await ensureCursorHelpSlotUsable(slot);
  }
  const debugState = await getCursorHelpPoolDebugState();
  const next = resolveHeartbeatDelay(debugState);
  scheduleCursorHelpPoolHeartbeat(next.delayMs);
  return debugState;
}

export async function runCursorHelpPoolHeartbeat(): Promise<CursorHelpPoolDebugView> {
  ensureCursorHelpSlotLifecycle();
  const state = await loadCursorHelpPoolState();
  for (const slot of state.slots) {
    clearStaleExecution(slot.slotId, slot.tabId);
    const usable = await ensureCursorHelpSlotUsable(slot).catch(() => null);
    if (usable) continue;
    const refreshed = (await loadCursorHelpPoolState()).slots.find(
      (item) => item.slotId === slot.slotId,
    );
    if (refreshed?.lastHealthReason === "tab-missing") {
      await attemptCursorHelpSlotRecovery(refreshed);
      continue;
    }
    if (
      refreshed?.lastHealthReason === "page-not-ready" ||
      refreshed?.lastHealthReason === "inspect-failed"
    ) {
      await attemptCursorHelpSlotSoftRecovery(refreshed);
    }
  }
  const latestState = await loadCursorHelpPoolState();
  await tryAutoShrinkPool(latestState);
  const debugState = await getCursorHelpPoolDebugState();
  cursorHelpHeartbeatLastAt = nowMs();
  const next = resolveHeartbeatDelay(debugState);
  cursorHelpHeartbeatLastReason = `manual:${next.reason}`;
  if (cursorHelpHeartbeatTimer) {
    clearTimeout(cursorHelpHeartbeatTimer);
    cursorHelpHeartbeatTimer = null;
  }
  scheduleCursorHelpPoolHeartbeat(next.delayMs);
  if (debugState.summary && typeof debugState.summary === "object") {
    debugState.summary.lastHeartbeatAt = cursorHelpHeartbeatLastAt;
    debugState.summary.lastHeartbeatDelayMs = cursorHelpHeartbeatLastDelayMs;
    debugState.summary.lastHeartbeatReason = cursorHelpHeartbeatLastReason;
    debugState.summary.heartbeatInFlight = cursorHelpHeartbeatInFlight;
  }
  return debugState;
}

export async function rebuildCursorHelpPool(
  slotCount = DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT,
): Promise<CursorHelpPoolDebugView> {
  const current = await loadCursorHelpPoolState();
  if (current.windowId) {
    await chrome.windows.remove(current.windowId).catch(() => {
      // noop
    });
  }
  for (const slot of current.slots) {
    clearSlotPreferences(slot.slotId);
    closeActiveRequestForSlot(slot.slotId, "Cursor Help 运行池已重建");
  }
  await saveCursorHelpPoolState({
    version: 1,
    windowId: undefined,
    slots: [],
    updatedAt: nowMs(),
  });
  return await ensureCursorHelpPoolReady(slotCount);
}

export async function getCursorHelpPoolDebugState(): Promise<CursorHelpPoolDebugView> {
  const state = await loadCursorHelpPoolState();
  const window = state.windowId
    ? await chrome.windows.get(state.windowId).catch(() => null)
    : null;
  const windowRuntimeState = resolveCursorHelpWindowRuntimeState(state, window);
  const recoveryPreview = buildCursorHelpWindowRecoveryPreview(state);
  const decisionTrace = await collectCursorHelpTabDecisionTrace(state);
  const adoptPreview = buildCursorHelpAdoptDecisionPreview(state, decisionTrace);
  const backgroundPreview = buildCursorHelpBackgroundDecisionPreview(windowRuntimeState);
  const slots = sortSlotsForDisplay(state.slots).map((slot) => {
    const activeRequestId = String(
      ACTIVE_REQUEST_ID_BY_SLOT.get(slot.slotId) || "",
    ).trim();
    const entry = activeRequestId
      ? ACTIVE_BY_REQUEST_ID.get(activeRequestId)
      : null;
    return {
      slotId: slot.slotId,
      tabId: slot.tabId,
      windowId: slot.windowId || null,
      lanePreference: slot.lanePreference,
      status:
        entry && !entry.closed
          ? "busy"
          : slot.status,
      activeRequestId: entry?.requestId || null,
      activeSessionId: entry?.sessionId || null,
      activeConversationKey: entry?.conversationKey || null,
      activeLane: entry?.lane || null,
      lastKnownUrl: slot.lastKnownUrl,
      lastReadyAt: slot.lastReadyAt || 0,
      lastUsedAt: slot.lastUsedAt || 0,
      lastHealthCheckedAt: slot.lastHealthCheckedAt || 0,
      lastHealthReason: slot.lastHealthReason || "",
      lastError: slot.lastError || "",
    };
  });
  const readyCount = slots.filter((slot) => slot.status === "idle").length;
  const busyCount = slots.filter((slot) => slot.status === "busy").length;
  const errorCount = slots.filter(
    (slot) => slot.status === "error" || slot.status === "stale",
  ).length;
  return {
    summary: {
      windowId: state.windowId || null,
      slotCount: slots.length,
      readyCount,
      busyCount,
      errorCount,
      windowMode: state.windowMode || "none",
      windowStatus: windowRuntimeState.status,
      shouldRebuildWindow: windowRuntimeState.shouldRebuild,
      allowBackgrounding: windowRuntimeState.allowBackgrounding,
      requiresAttention: windowRuntimeState.requiresAttention,
      recoveryCooldownActive: windowRuntimeState.recoveryCooldownActive,
      recoveryCooldownUntil: windowRuntimeState.recoveryCooldownUntil || 0,
      backgroundBlockedReason: windowRuntimeState.backgroundBlockedReason || "",
      recoveryAction: recoveryPreview.action,
      recoveryReason: recoveryPreview.reason,
      liveCursorHelpTabCount: decisionTrace.liveCursorHelpTabCount,
      managedCursorHelpTabCount: decisionTrace.managedCursorHelpTabCount,
      unmanagedCursorHelpTabCount: decisionTrace.unmanagedCursorHelpTabCount,
      adoptAction: adoptPreview.action,
      adoptReason: adoptPreview.reason,
      backgroundAction: backgroundPreview.action,
      backgroundReason: backgroundPreview.reason,
      lastHeartbeatAt: cursorHelpHeartbeatLastAt,
      lastHeartbeatDelayMs: cursorHelpHeartbeatLastDelayMs,
      lastHeartbeatReason: cursorHelpHeartbeatLastReason,
      heartbeatInFlight: cursorHelpHeartbeatInFlight,
      lastWindowEvent: state.lastWindowEvent || "",
      lastWindowEventAt: state.lastWindowEventAt || 0,
      lastWindowEventReason: state.lastWindowEventReason || "",
      autoscaleLastExpandAt: lastAutoExpandAt,
      autoscaleLastExpandReason: lastAutoExpandReason,
      autoscaleLastShrinkAt: lastAutoShrinkAt,
      autoscaleLastShrinkReason: lastAutoShrinkReason,
    },
    window: window
      ? {
          id: window.id || null,
          focused: window.focused === true,
          state: String(window.state || ""),
          type: String(window.type || ""),
          tabCount: Array.isArray(window.tabs) ? window.tabs.length : undefined,
          mode: state.windowMode || "none",
          runtimeStatus: windowRuntimeState.status,
          shouldRebuild: windowRuntimeState.shouldRebuild,
          allowBackgrounding: windowRuntimeState.allowBackgrounding,
          requiresAttention: windowRuntimeState.requiresAttention,
          recoveryCooldownActive: windowRuntimeState.recoveryCooldownActive,
          recoveryCooldownUntil: windowRuntimeState.recoveryCooldownUntil || 0,
          backgroundBlockedReason: windowRuntimeState.backgroundBlockedReason || "",
          recoveryAction: recoveryPreview.action,
          recoveryReason: recoveryPreview.reason,
          lastEvent: state.lastWindowEvent || "",
          lastEventAt: state.lastWindowEventAt || 0,
          lastEventReason: state.lastWindowEventReason || "",
        }
      : null,
    tabDecisionTrace: decisionTrace.entries,
    slots,
  };
}

const PERMANENT_TAB_MESSAGE_ERRORS = [
  "Could not establish connection",
  "Extension context invalidated",
  "No tab with id",
];

async function sendTabMessageWithRetry(tabId: number, message: Record<string, unknown>, retries = 12): Promise<unknown> {
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

export function createCursorHelpWebProvider() {
  ensureCursorHelpSlotLifecycle();
  return {
    id: PROVIDER_ID,
    resolveRequestUrl() {
      return "browser-brain-loop://hosted-chat/cursor-help-web";
    },
    async send(input: LlmProviderSendInput): Promise<Response> {
      const lane = normalizeExecutionLane(input.lane);
      emitProviderDebugLog(
        "provider.resolve_slot",
        "running",
        `lane=${lane} 开始解析目标 Cursor Help 执行槽位`,
      );

      const resolved = await waitForCursorHelpSlot(input, lane);
      const { sessionId, slot, inspect, conversationKey } = resolved;
      emitProviderDebugLog(
        "provider.resolve_slot",
        "done",
        `session=${sessionId} slot=${slot.slotId} tab=${slot.tabId} lane=${lane}`,
      );
      clearStaleExecution(slot.slotId, slot.tabId);

      const sessionLaneKey = buildSessionLaneKey(sessionId, lane);
      const laneConflict = resolveSessionLaneConflict(sessionId, lane);
      if (laneConflict.kind !== "none") {
        emitProviderDebugLog(
          "provider.lane_conflict",
          "failed",
          `session=${sessionId} lane=${lane} kind=${laneConflict.kind} reason=${laneConflict.reason}`,
        );
        throw new Error(laneConflict.message || `会话 ${sessionId} 的 ${lane} lane 当前不可用`);
      }
      if (ACTIVE_REQUEST_ID_BY_SLOT.has(slot.slotId)) {
        throw new Error(
          `槽位 ${slot.slotId} 正在执行网页 provider 请求`,
        );
      }
      if (ACTIVE_REQUEST_ID_BY_TAB.has(slot.tabId)) {
        throw new Error(
          `目标标签页 ${slot.tabId} 正在执行网页 provider 请求`,
        );
      }

      const requestId = `cursor-help-${crypto.randomUUID()}`;

      // Atomic acquire: register slot/tab/lane immediately to prevent concurrent send() races
      ACTIVE_REQUEST_ID_BY_SLOT.set(slot.slotId, requestId);
      ACTIVE_REQUEST_ID_BY_TAB.set(slot.tabId, requestId);
      ACTIVE_REQUEST_ID_BY_SESSION_LANE.set(sessionLaneKey, requestId);

      let compiledPrompt: string;
      let latestUserPrompt: string;
      let requestedModel: string;
      try {
        compiledPrompt = buildCursorHelpCompiledPrompt(
          input.payload.messages,
          input.payload.tools,
          input.payload.tool_choice,
        );
        latestUserPrompt = extractLastUserMessage(input.payload.messages);
        requestedModel =
          String(input.route.llmModel || "").trim() || "auto";
      } catch (error) {
        ACTIVE_REQUEST_ID_BY_SLOT.delete(slot.slotId);
        ACTIVE_REQUEST_ID_BY_TAB.delete(slot.tabId);
        ACTIVE_REQUEST_ID_BY_SESSION_LANE.delete(sessionLaneKey);
        throw error instanceof Error ? error : new Error(String(error));
      }
      const entry: PendingExecution = {
        requestId,
        sessionId,
        slotId: slot.slotId,
        lane,
        tabId: slot.tabId,
        windowId: slot.windowId,
        createdAt: nowMs(),
        lastEventAt: nowMs(),
        startedAt: null,
        timeoutHandle: null,
        controller: null,
        queue: [],
        firstDeltaLogged: false,
        conversationKey: conversationKey || null,
        closed: false,
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
        },
      });

      ACTIVE_BY_REQUEST_ID.set(requestId, entry);
      await markCursorHelpSlotBusy(slot);
      PREFERRED_SLOT_ID_BY_SESSION.set(sessionId, slot.slotId);
      armExecutionWatchdog(
        entry,
        EXECUTION_BOOT_TIMEOUT_MS,
        "网页 provider 请求未启动，请确认 Cursor Help 页面已加载完成",
      );
      emitProviderDebugLog(
        "provider.execute",
        "running",
        `向 slot=${slot.slotId} tab=${slot.tabId} 发送 webchat.execute lane=${lane}`,
      );

      input.signal.addEventListener(
        "abort",
        () => {
          void chrome.tabs
            .sendMessage(slot.tabId, {
              type: "webchat.abort",
              requestId,
            })
            .catch(() => {
              // noop
            });
          failExecution(entry, "webchat provider aborted");
        },
        { once: true },
      );

      try {
        const response = await sendTabMessageWithRetry(slot.tabId, {
          type: "webchat.execute",
          requestId,
          sessionId,
          compiledPrompt,
          latestUserPrompt,
          requestedModel,
          lane,
          slotId: slot.slotId,
          conversationKey: conversationKey || undefined,
        });
        const row = toRecord(response);
        if (row.ok !== true) {
          emitProviderDebugLog(
            "provider.execute",
            "failed",
            String(row.error || "目标网页执行器未就绪"),
          );
          throw new Error(
            String(row.error || "目标网页执行器未就绪"),
          );
        }
        emitProviderDebugLog(
          "provider.execute",
          "done",
          `content script 已确认接收 execute 请求${
            row.senderKind ? ` (${String(row.senderKind)})` : ""
          }`,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failExecution(entry, errorMessage);
        emitProviderDebugLog(
          "provider.execute",
          "failed",
          errorMessage,
        );
        throw error instanceof Error ? error : new Error(errorMessage);
      }

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": HOSTED_CHAT_RESPONSE_CONTENT_TYPE,
          "cache-control": "no-cache",
        },
      });
    },
  };
}

export async function handleWebChatRuntimeMessage(message: unknown, senderTabId?: number): Promise<boolean> {
  const payload = toRecord(message);
  if (String(payload.type || "").trim() !== "webchat.transport") return false;
  const event = parseHostedChatTransportEvent(payload.envelope);
  if (!event) return true;
  const entry = ACTIVE_BY_REQUEST_ID.get(event.requestId);
  if (!entry) return true;
  if (senderTabId && entry.tabId !== senderTabId) return true;

  touchExecution(entry);

  if (event.type === "hosted_chat.debug") {
    enqueueHostedEvent(entry, event);
    if (event.stage === "request_started") {
      entry.startedAt = nowMs();
      armExecutionWatchdog(entry, EXECUTION_STALE_MS, "网页 provider 请求长时间未结束");
      const requestedConversationKey = String(toRecord(event.meta).conversationKey || "").trim();
      if (requestedConversationKey && !entry.conversationKey) {
        entry.conversationKey = requestedConversationKey;
      }
      const sessionKey = String(toRecord(event.meta).sessionKey || "").trim();
      if (sessionKey) {
        entry.conversationKey = sessionKey;
        LAST_CONVERSATION_KEY_BY_SESSION.set(entry.sessionId, sessionKey);
        PREFERRED_SLOT_ID_BY_CONVERSATION.set(sessionKey, entry.slotId);
        PREFERRED_SLOT_ID_BY_SESSION.set(entry.sessionId, entry.slotId);
      }
      emitProviderDebugLog(
        "provider.request_started",
        "done",
        `slot=${entry.slotId} tab=${entry.tabId} lane=${entry.lane} 页面内聊天请求已发出${sessionKey ? ` sessionKey=${sessionKey}` : ""}`,
      );
      const rewriteSummary = formatRewriteDebugSummary(toRecord(event.meta).rewriteDebug);
      if (rewriteSummary) {
        emitProviderDebugLog("provider.request_rewrite", "done", rewriteSummary);
      }
    }
    return true;
  }

  if (event.type === "hosted_chat.stream_text_delta") {
    enqueueHostedEvent(entry, event);
    if (!entry.firstDeltaLogged && event.deltaText) {
      entry.firstDeltaLogged = true;
      emitProviderDebugLog("provider.first_delta", "done", `收到输出片段，长度=${event.deltaText.length}`);
    }
    armExecutionWatchdog(entry, EXECUTION_STALE_MS, "网页 provider 请求长时间无新输出");
    return true;
  }

  if (event.type === "hosted_chat.tool_call_detected") {
    enqueueHostedEvent(entry, event);
    emitProviderDebugLog(
      "provider.tool_detected",
      "done",
      `检测到 ${event.toolCalls.length} 个工具计划`
    );
    armExecutionWatchdog(entry, EXECUTION_STALE_MS, "网页 provider 请求长时间无新输出");
    return true;
  }

  if (event.type === "hosted_chat.turn_resolved") {
    enqueueHostedEvent(entry, event);
    closeExecution(entry);
    emitProviderDebugLog(
      "provider.done",
      "done",
      `网页 provider 回合完成 finishReason=${event.result.finishReason}`
    );
    return true;
  }

  if (event.type === "hosted_chat.transport_error") {
    enqueueHostedEvent(entry, event);
    emitProviderDebugLog("provider.error", "failed", event.error);
    failExecution(entry, event.error);
    return true;
  }

  return true;
}
