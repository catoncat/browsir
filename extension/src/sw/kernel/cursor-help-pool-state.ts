import type { CursorHelpSlotRecord, CursorHelpPoolState } from "./cursor-help-pool-policy";

const CURSOR_HELP_POOL_STORAGE_KEY = "cursor_help_web.pool.v1";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function cloneSlotRecord(slot: CursorHelpSlotRecord): CursorHelpSlotRecord {
  return {
    ...slot,
  };
}

export function normalizeSlotRecord(value: unknown): CursorHelpSlotRecord | null {
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

export function normalizePoolState(value: unknown): CursorHelpPoolState {
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

export async function loadCursorHelpPoolState(): Promise<CursorHelpPoolState> {
  const stored = await chrome.storage.local
    .get(CURSOR_HELP_POOL_STORAGE_KEY)
    .catch(() => null);
  return normalizePoolState(stored?.[CURSOR_HELP_POOL_STORAGE_KEY]);
}

export async function persistCursorHelpPoolState(
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

export async function saveCursorHelpPoolState(
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
    updatedAt: Date.now(),
  };
  await persistCursorHelpPoolState(next);
  return next;
}

export async function patchCursorHelpSlotState(
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
