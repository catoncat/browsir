import {
  buildCursorHelpCompiledPrompt,
  extractLastUserMessage,
  parseHostedChatTransportEvent,
  serializeHostedChatTransportEvent,
  type HostedChatTransportEvent
} from "../../shared/cursor-help-web-shared";
import {
  type CursorHelpExecutionPayload,
  type CursorHelpSenderInspect,
} from "../../shared/cursor-help-protocol";
import { CURSOR_HELP_RUNTIME_VERSION } from "../../shared/cursor-help-runtime-meta";
import type {
  LlmProviderExecutionLane,
  LlmProviderSendInput,
} from "./llm-provider";

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

interface CursorHelpSlotRecord {
  slotId: string;
  tabId: number;
  windowId?: number;
  lanePreference: "primary" | "auxiliary";
  status: "cold" | "warming" | "idle" | "busy" | "stale" | "error";
  lastKnownUrl: string;
  lastReadyAt: number;
  lastUsedAt: number;
  lastError?: string;
}

interface CursorHelpPoolState {
  version: 1;
  windowId?: number;
  slots: CursorHelpSlotRecord[];
  updatedAt: number;
}

interface CursorHelpInspectResult extends CursorHelpSenderInspect {
  url: string;
  selectedModel?: string;
  availableModels?: string[];
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
const EXECUTION_BOOT_TIMEOUT_MS = 20_000;
const EXECUTION_STALE_MS = 90_000;
const SLOT_WAIT_POLL_MS = 200;
const PRIMARY_SLOT_WAIT_MS = 15_000;
const AUXILIARY_SLOT_WAIT_MS = 10_000;
const DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT = 3;
const MIN_CURSOR_HELP_POOL_SLOT_COUNT = 2;
const MAX_CURSOR_HELP_POOL_SLOT_COUNT = 6;
const encoder = new TextEncoder();
const CONTENT_SCRIPT_FILE = "assets/cursor-help-content.js";
const PAGE_HOOK_SCRIPT_FILE = "assets/cursor-help-page-hook.js";
const CURSOR_HELP_SESSION_SLOT_STORAGE_KEY = "cursor_help_web.session_slots";
const CURSOR_HELP_POOL_STORAGE_KEY = "cursor_help_web.pool.v1";
const CURSOR_HELP_CONTAINER_WIDTH = 1280;
const CURSOR_HELP_CONTAINER_HEIGHT = 900;
const HOSTED_CHAT_RESPONSE_CONTENT_TYPE = "application/x-browser-brain-loop-hosted-chat+jsonl";
let cursorHelpSlotLifecycleBoundTabs: typeof chrome.tabs | null = null;
let cursorHelpSlotLifecycleBoundWindows: typeof chrome.windows | null = null;

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

function normalizeExecutionLane(
  lane: unknown,
): LlmProviderExecutionLane {
  const normalized = String(lane || "").trim().toLowerCase();
  if (normalized === "compaction") return "compaction";
  if (normalized === "title") return "title";
  return "primary";
}

function toSlotLanePreference(
  lane: LlmProviderExecutionLane,
): "primary" | "auxiliary" {
  return lane === "primary" ? "primary" : "auxiliary";
}

function buildSessionLaneKey(
  sessionId: string,
  lane: LlmProviderExecutionLane,
): string {
  return `${String(sessionId || "").trim()}::${lane}`;
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
  return {
    version: 1,
    windowId: Number.isInteger(windowId) && windowId > 0 ? windowId : undefined,
    slots,
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
    updatedAt: nowMs(),
  };
  await persistCursorHelpPoolState(next);
  return next;
}

function sortSlotsForDisplay(
  slots: CursorHelpSlotRecord[],
): CursorHelpSlotRecord[] {
  return [...slots].sort((left, right) => {
    const laneDiff =
      (left.lanePreference === "primary" ? 0 : 1) -
      (right.lanePreference === "primary" ? 0 : 1);
    if (laneDiff !== 0) return laneDiff;
    return left.slotId.localeCompare(right.slotId);
  });
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
  for (const [sessionId, preferredSlotId] of PREFERRED_SLOT_ID_BY_SESSION) {
    if (preferredSlotId === normalizedSlotId) {
      PREFERRED_SLOT_ID_BY_SESSION.delete(sessionId);
    }
  }
  for (const [conversationKey, preferredSlotId] of PREFERRED_SLOT_ID_BY_CONVERSATION) {
    if (preferredSlotId === normalizedSlotId) {
      PREFERRED_SLOT_ID_BY_CONVERSATION.delete(conversationKey);
    }
  }
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

function closeExecution(entry: PendingExecution): void {
  if (entry.closed) return;
  entry.closed = true;
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
  void patchCursorHelpSlotState(entry.slotId, {
    status: "idle",
    lastUsedAt: nowMs(),
    lastError: "",
    lastReadyAt: Math.max(entry.lastEventAt, entry.createdAt),
  });
  if (entry.controller) {
    entry.controller.close();
  }
}

function failExecution(entry: PendingExecution, error: string): void {
  if (entry.closed) return;
  entry.closed = true;
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
  if (entry.startedAt === null) {
    void patchCursorHelpSlotState(entry.slotId, {
      status: "stale",
      lastUsedAt: nowMs(),
      lastError: error,
    }).catch(() => {
      // noop
    });
  } else {
    void patchCursorHelpSlotState(entry.slotId, {
      status: "error",
      lastUsedAt: nowMs(),
      lastError: error,
    }).catch(() => {
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
): Promise<void> {
  if (!Number.isInteger(windowId) || Number(windowId) <= 0) return;
  await chrome.windows
    .update(Number(windowId), { state: "minimized" })
    .catch(() => {
      // noop
    });
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
    lastError: undefined,
  };
}

async function createCursorHelpPoolWindow(
  slotCount: number,
): Promise<CursorHelpPoolState> {
  const desiredSlotCount = normalizePoolSlotCount(slotCount);
  const createdWindow = await chrome.windows
    .create({
      url: CURSOR_HELP_URL,
      focused: false,
      width: CURSOR_HELP_CONTAINER_WIDTH,
      height: CURSOR_HELP_CONTAINER_HEIGHT,
    })
    .catch(async () => {
      return chrome.windows.create({
        url: CURSOR_HELP_URL,
        focused: false,
        type: "popup",
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
  slots.push(buildCursorHelpSlotRecord(firstTab, "primary"));

  for (let index = 1; index < desiredSlotCount; index += 1) {
    const tab = await chrome.tabs.create({
      windowId: createdWindow.id,
      url: CURSOR_HELP_URL,
      active: false,
    });
    if (!tab?.id) continue;
    await markCursorHelpTabStable(tab.id);
    slots.push(buildCursorHelpSlotRecord(tab, "auxiliary"));
  }

  await minimizeCursorHelpWindow(createdWindow.id);
  await clearLegacySessionSlots();
  return await saveCursorHelpPoolState({
    version: 1,
    windowId: createdWindow.id,
    slots: sortSlotsForDisplay(slots),
    updatedAt: nowMs(),
  });
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
  return buildCursorHelpSlotRecord(tab, lanePreference);
}

async function reconcileCursorHelpPoolState(
  slotCount: number,
): Promise<CursorHelpPoolState> {
  const desiredSlotCount = normalizePoolSlotCount(slotCount);
  const current = await loadCursorHelpPoolState();
  const windowAlive = await isCursorHelpWindowAlive(current.windowId);
  let windowId = windowAlive ? current.windowId : undefined;
  let slots = (
    await Promise.all(current.slots.map((slot) => readLiveCursorHelpSlot(slot)))
  ).filter((slot): slot is CursorHelpSlotRecord => Boolean(slot));

  if (!windowId && slots.length > 0) {
    windowId = slots[0].windowId;
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
    updatedAt: nowMs(),
  });
  await minimizeCursorHelpWindow(windowId);
  await clearLegacySessionSlots();
  return nextState;
}

async function markCursorHelpSlotBusy(
  slot: CursorHelpSlotRecord,
  entry: PendingExecution,
): Promise<void> {
  await patchCursorHelpSlotState(slot.slotId, {
    status: "busy",
    lastUsedAt: nowMs(),
    lastError: "",
    windowId: slot.windowId,
    lastKnownUrl: slot.lastKnownUrl,
  });
  ACTIVE_REQUEST_ID_BY_SLOT.set(slot.slotId, entry.requestId);
  ACTIVE_REQUEST_ID_BY_TAB.set(slot.tabId, entry.requestId);
  ACTIVE_REQUEST_ID_BY_SESSION_LANE.set(
    buildSessionLaneKey(entry.sessionId, entry.lane),
    entry.requestId,
  );
}

function classifySlotStatusFromInspect(
  inspect: CursorHelpInspectResult | null,
): CursorHelpSlotRecord["status"] {
  if (!inspect) return "stale";
  if (inspect.runtimeMismatch) return "error";
  if (inspect.canExecute) return "idle";
  return "warming";
}

async function ensureCursorHelpSlotUsable(
  slot: CursorHelpSlotRecord,
): Promise<{ slot: CursorHelpSlotRecord; inspect: CursorHelpInspectResult } | null> {
  const tab = await chrome.tabs.get(slot.tabId).catch(() => null);
  if (!tab?.id || !isCursorHelpUrl(tab.url)) {
    await patchCursorHelpSlotState(slot.slotId, {
      status: "stale",
      lastError: "slot tab missing",
    });
    clearSlotPreferences(slot.slotId);
    return null;
  }
  await markCursorHelpTabStable(tab.id);
  try {
    await waitForCursorHelpTabReady(tab.id);
  } catch (error) {
    await patchCursorHelpSlotState(slot.slotId, {
      status: "stale",
      lastError: error instanceof Error ? error.message : String(error),
      windowId: typeof tab.windowId === "number" ? tab.windowId : slot.windowId,
      lastKnownUrl: String(tab.url || slot.lastKnownUrl || ""),
    });
    return null;
  }
  const inspect = await inspectCursorTabEnsured(tab.id);
  const status = classifySlotStatusFromInspect(inspect);
  await patchCursorHelpSlotState(slot.slotId, {
    status,
    windowId: typeof tab.windowId === "number" ? tab.windowId : slot.windowId,
    lastKnownUrl: String(inspect?.url || tab.url || slot.lastKnownUrl || ""),
    lastReadyAt: inspect?.canExecute ? nowMs() : slot.lastReadyAt,
    lastError:
      inspect?.canExecute === true ? "" : formatInspectFailure(inspect),
  });
  if (!inspect?.canExecute) return null;
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

async function waitForCursorHelpSlot(
  input: LlmProviderSendInput,
  lane: LlmProviderExecutionLane,
): Promise<{ sessionId: string; slot: CursorHelpSlotRecord; inspect: CursorHelpInspectResult }> {
  const sessionId = String(input.sessionId || "").trim() || "default";
  const conversationKey = String(
    toRecord(input.payload).conversationKey || "",
  ).trim();
  const deadline =
    nowMs() + (lane === "primary" ? PRIMARY_SLOT_WAIT_MS : AUXILIARY_SLOT_WAIT_MS);
  const desiredSlotCount = readRequestedPoolSlotCount(input);

  while (nowMs() < deadline) {
    const state = await reconcileCursorHelpPoolState(desiredSlotCount);
    const chosen = chooseCursorHelpSlot(state.slots, lane, sessionId, conversationKey);
    if (chosen) {
      const usable = await ensureCursorHelpSlotUsable(chosen);
      if (usable) {
        return {
          sessionId,
          slot: usable.slot,
          inspect: usable.inspect,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, SLOT_WAIT_POLL_MS));
  }

  throw new Error(
    lane === "primary"
      ? "Cursor Help 主执行槽位繁忙，请稍后重试。"
      : "Cursor Help 辅助执行槽位繁忙，请稍后重试。",
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
  if (removedSlots.length <= 0 && current.windowId !== windowId) return;
  for (const slot of removedSlots) {
    closeActiveRequestForSlot(slot.slotId, "Cursor Help 专用窗口已关闭");
    clearSlotPreferences(slot.slotId);
  }
  current.slots = current.slots.filter((slot) => slot.windowId !== windowId);
  if (current.windowId === windowId) {
    current.windowId = undefined;
  }
  await saveCursorHelpPoolState(current);
}

function ensureCursorHelpSlotLifecycle(): void {
  const tabsApi = chrome.tabs;
  if (tabsApi?.onRemoved?.addListener && cursorHelpSlotLifecycleBoundTabs !== tabsApi) {
    cursorHelpSlotLifecycleBoundTabs = tabsApi;
    tabsApi.onRemoved.addListener((tabId) => {
      void removeCursorHelpSlotByTabId(tabId);
    });
  }
  const windowsApi = chrome.windows;
  if (
    windowsApi?.onRemoved?.addListener &&
    cursorHelpSlotLifecycleBoundWindows !== windowsApi
  ) {
    cursorHelpSlotLifecycleBoundWindows = windowsApi;
    windowsApi.onRemoved.addListener((windowId) => {
      void removeCursorHelpSlotsByWindowId(windowId);
    });
  }
}

export async function ensureCursorHelpPoolReady(
  slotCount = DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT,
): Promise<CursorHelpPoolDebugView> {
  ensureCursorHelpSlotLifecycle();
  const state = await reconcileCursorHelpPoolState(slotCount);
  for (const slot of state.slots) {
    await ensureCursorHelpSlotUsable(slot);
  }
  return await getCursorHelpPoolDebugState();
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
  const window =
    state.windowId && (await chrome.windows.get(state.windowId).catch(() => null))
      ? await chrome.windows.get(state.windowId).catch(() => null)
      : null;
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
    },
    window: window
      ? {
          id: window.id || null,
          focused: window.focused === true,
          state: String(window.state || ""),
          type: String(window.type || ""),
          tabCount: Array.isArray(window.tabs) ? window.tabs.length : undefined,
        }
      : null,
    slots,
  };
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
      return "browser-brain-loop://hosted-chat/cursor-help-web";
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
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        startedAt: null,
        timeoutHandle: null,
        controller: null,
        queue: [],
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

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": HOSTED_CHAT_RESPONSE_CONTENT_TYPE,
          "cache-control": "no-cache"
        }
      });
    }
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
      entry.startedAt = Date.now();
      armExecutionWatchdog(entry, EXECUTION_STALE_MS, "网页 provider 请求长时间未结束");
      const sessionKey = String(toRecord(event.meta).sessionKey || "").trim();
      emitProviderDebugLog(
        "provider.request_started",
        "done",
        `tab=${entry.tabId} 页面内聊天请求已发出${sessionKey ? ` sessionKey=${sessionKey}` : ""}`
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
    closeExecution(entry);
    return true;
  }

  return true;
}
