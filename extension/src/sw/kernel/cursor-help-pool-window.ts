import {
  type CursorHelpSlotRecord,
  type CursorHelpPoolState,
  withWindowEvent,
  sortSlotsForDisplay,
} from "./cursor-help-pool-policy";
import { canCursorHelpSlotBootExecute } from "./cursor-help-health";
import { saveCursorHelpPoolState } from "./cursor-help-pool-state";
import {
  CURSOR_HELP_URL,
  markCursorHelpTabStable,
  waitForCursorHelpTabReady,
  waitForCursorHelpInspectReady,
  clearLegacySessionSlots,
  minimizeCursorHelpWindow,
} from "./cursor-help-tab-ops";

const CURSOR_TAB_PATTERNS = ["https://cursor.com/help*"] as const;
const CURSOR_HELP_CONTAINER_WIDTH = 1280;
const CURSOR_HELP_CONTAINER_HEIGHT = 900;

export const DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT = 3;
export const MIN_CURSOR_HELP_POOL_SLOT_COUNT = 2;
export const MAX_CURSOR_HELP_POOL_SLOT_COUNT = 6;

function nowMs(): number {
  return Date.now();
}

function randomSlotId(): string {
  return `cursor-slot-${crypto.randomUUID()}`;
}

export function normalizePoolSlotCount(raw: unknown): number {
  const count = Number(raw);
  if (!Number.isInteger(count)) return DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT;
  return Math.min(
    MAX_CURSOR_HELP_POOL_SLOT_COUNT,
    Math.max(MIN_CURSOR_HELP_POOL_SLOT_COUNT, count),
  );
}

export function buildCursorHelpSlotRecord(
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

export async function tryAdoptExistingCursorHelpSlots(
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

export async function createCursorHelpPoolWindow(
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

export async function createAdditionalPoolSlot(
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

export async function collectCursorHelpTabDecisionTrace(
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
