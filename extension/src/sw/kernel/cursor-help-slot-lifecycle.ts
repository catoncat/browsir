import type { CursorHelpSlotRecord } from "./cursor-help-pool-policy";
import type { CursorHelpInspectResult } from "./cursor-help-health";
import {
  canCursorHelpSlotBootExecute,
  classifyInspectHealth,
  buildSlotHealthSnapshot,
  getRecoveryBudget,
  formatInspectFailure,
} from "./cursor-help-health";
import { patchCursorHelpSlotState } from "./cursor-help-pool-state";
import {
  isCursorHelpUrl,
  markCursorHelpTabStable,
  waitForCursorHelpTabReady,
  inspectCursorTabEnsured,
  injectCursorHelpScripts,
  isCursorHelpWindowAlive,
} from "./cursor-help-tab-ops";
import { createAdditionalPoolSlot } from "./cursor-help-pool-window";
import { clearSlotPreferences } from "./cursor-help-slot-preferences";

const CURSOR_HELP_HEARTBEAT_RECOVERY_RETRY_MS = 500;

function nowMs(): number {
  return Date.now();
}

export async function markCursorHelpSlotBusy(
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

export async function ensureCursorHelpSlotUsable(
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
  if (!inspect || !canCursorHelpSlotBootExecute(inspect)) {
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

export async function attemptCursorHelpSlotRecovery(
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

export async function attemptCursorHelpSlotSoftRecovery(
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
