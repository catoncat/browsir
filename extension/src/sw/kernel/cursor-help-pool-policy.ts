import type { LlmProviderExecutionLane } from "./llm-provider";

type JsonRecord = Record<string, unknown>;

export interface CursorHelpSlotRecord {
  slotId: string;
  tabId: number;
  windowId?: number;
  lanePreference: "primary" | "auxiliary";
  status: "cold" | "warming" | "idle" | "busy" | "recovering" | "stale" | "error";
  lastKnownUrl: string;
  lastReadyAt: number;
  lastUsedAt: number;
  lastHealthCheckedAt: number;
  lastHealthReason?: string;
  recoveryAttemptCount: number;
  lastRecoveryReason?: string;
  lastError?: string;
}

export interface CursorHelpPoolState {
  version: 1;
  windowId?: number;
  slots: CursorHelpSlotRecord[];
  windowMode?: "none" | "external-tabs" | "pool-window";
  windowRecoveryCooldownUntil?: number;
  lastWindowEvent?: string;
  lastWindowEventAt?: number;
  lastWindowEventReason?: string;
  updatedAt: number;
}

export type CursorHelpWindowStatus =
  | "none"
  | "external-tabs"
  | "normal"
  | "minimized"
  | "missing";

export interface CursorHelpWindowPolicyState {
  windowStatus: CursorHelpWindowStatus;
  shouldRebuildWindow: boolean;
  requiresAttention: boolean;
  shouldBackgroundWindow: boolean;
  recoveryCooldownActive: boolean;
  recoveryCooldownUntil?: number;
  backgroundBlockedReason?: string;
}

export function withWindowEvent(
  state: CursorHelpPoolState,
  event: string,
  options: {
    mode?: CursorHelpPoolState["windowMode"];
    reason?: string;
    recoveryCooldownUntil?: number;
  } = {},
): CursorHelpPoolState {
  return {
    ...state,
    windowMode: options.mode || state.windowMode || "none",
    windowRecoveryCooldownUntil:
      typeof options.recoveryCooldownUntil === "number"
        ? options.recoveryCooldownUntil
        : state.windowRecoveryCooldownUntil,
    lastWindowEvent: String(event || "").trim() || undefined,
    lastWindowEventAt: Date.now(),
    lastWindowEventReason: String(options.reason || "").trim() || undefined,
  };
}

export function buildCursorHelpWindowPolicyState(
  state: CursorHelpPoolState,
  liveWindow: { id?: number; type?: string; state?: string } | null,
): CursorHelpWindowPolicyState {
  if (state.windowMode === "external-tabs") {
    return {
      windowStatus: "external-tabs",
      shouldRebuildWindow: false,
      requiresAttention: false,
      shouldBackgroundWindow: false,
      recoveryCooldownActive: false,
      recoveryCooldownUntil: undefined,
      backgroundBlockedReason: "external-tabs-are-user-owned",
    };
  }

  if (state.windowMode === "pool-window") {
    const recoveryCooldownUntil = Math.max(
      0,
      Number(state.windowRecoveryCooldownUntil || 0),
    );
    const recoveryCooldownActive = recoveryCooldownUntil > Date.now();
    if (!liveWindow?.id) {
      return {
        windowStatus: "missing",
        shouldRebuildWindow: !recoveryCooldownActive,
        requiresAttention: true,
        shouldBackgroundWindow: false,
        recoveryCooldownActive,
        recoveryCooldownUntil:
          recoveryCooldownUntil > 0 ? recoveryCooldownUntil : undefined,
        backgroundBlockedReason: recoveryCooldownActive
          ? "rebuild-cooldown-active"
          : "pool-window-missing",
      };
    }
    const windowType = String(liveWindow.type || "").trim() || "normal";
    const isPopup = windowType === "popup";
    const isMinimized = String(liveWindow.state || "").trim() === "minimized";
    return {
      windowStatus: isMinimized ? "minimized" : "normal",
      shouldRebuildWindow: false,
      requiresAttention: false,
      shouldBackgroundWindow: isPopup && !isMinimized,
      recoveryCooldownActive: false,
      recoveryCooldownUntil: undefined,
      backgroundBlockedReason: isPopup
        ? isMinimized
          ? "already-minimized"
          : undefined
        : `window-type=${windowType}`,
    };
  }

  return {
    windowStatus: "none",
    shouldRebuildWindow: false,
    requiresAttention: false,
    shouldBackgroundWindow: false,
    recoveryCooldownActive: false,
    recoveryCooldownUntil: undefined,
    backgroundBlockedReason: "no-managed-window",
  };
}

export function resolveCursorHelpWindowRuntimeState(
  state: CursorHelpPoolState,
  window: { id?: number; type?: string; state?: string } | null,
): {
  status: "none" | "external-tabs" | "minimized" | "normal" | "missing";
  shouldRebuild: boolean;
  allowBackgrounding: boolean;
  requiresAttention: boolean;
  recoveryCooldownActive: boolean;
  recoveryCooldownUntil?: number;
  backgroundBlockedReason?: string;
} {
  const policy = buildCursorHelpWindowPolicyState(state, window);
  return {
    status: policy.windowStatus,
    shouldRebuild: policy.shouldRebuildWindow,
    allowBackgrounding: policy.shouldBackgroundWindow,
    requiresAttention: policy.requiresAttention,
    recoveryCooldownActive: policy.recoveryCooldownActive,
    recoveryCooldownUntil: policy.recoveryCooldownUntil,
    backgroundBlockedReason: policy.backgroundBlockedReason,
  };
}

export function resolveMissingPoolWindowRecoveryAction(
  state: CursorHelpPoolState,
  options: {
    allowAutoRebuildAfterRemoval?: boolean;
  } = {},
): {
  action: "skip-cooldown" | "await-manual" | "auto-rebuild";
  reason: string;
} {
  const policy = buildCursorHelpWindowPolicyState(state, null);
  if (policy.recoveryCooldownActive) {
    return {
      action: "skip-cooldown",
      reason: `until=${policy.recoveryCooldownUntil || 0}`,
    };
  }
  if (
    state.windowMode === "pool-window" &&
    (state.lastWindowEvent === "pool_window_removed" ||
      state.lastWindowEvent === "await_manual_rebuild") &&
    options.allowAutoRebuildAfterRemoval !== true
  ) {
    return {
      action: "await-manual",
      reason: "window_removed",
    };
  }
  return {
    action: "auto-rebuild",
    reason: "auto-rebuild-allowed",
  };
}

export function buildCursorHelpWindowRecoveryPreview(
  state: CursorHelpPoolState,
): {
  action: "none" | "skip-cooldown" | "await-manual" | "auto-rebuild";
  reason: string;
} {
  if (state.windowMode !== "pool-window") {
    return { action: "none", reason: "not-a-managed-pool-window" };
  }
  return resolveMissingPoolWindowRecoveryAction(state, {
    allowAutoRebuildAfterRemoval: false,
  });
}

export function buildCursorHelpAdoptDecisionPreview(
  state: CursorHelpPoolState,
  trace: {
    managedCursorHelpTabCount: number;
    unmanagedCursorHelpTabCount: number;
  },
): {
  action: "already-adopted" | "adopt-available" | "no-candidates";
  reason: string;
} {
  if (state.windowMode === "external-tabs" && trace.managedCursorHelpTabCount > 0) {
    return {
      action: "already-adopted",
      reason: `managed=${trace.managedCursorHelpTabCount}`,
    };
  }
  if (trace.unmanagedCursorHelpTabCount > 0) {
    return {
      action: "adopt-available",
      reason: `unmanaged=${trace.unmanagedCursorHelpTabCount}`,
    };
  }
  return {
    action: "no-candidates",
    reason: "no-unmanaged-cursor-help-tabs",
  };
}

export function buildCursorHelpBackgroundDecisionPreview(
  windowRuntimeState: ReturnType<typeof resolveCursorHelpWindowRuntimeState>,
): {
  action: "background" | "skip";
  reason: string;
} {
  if (windowRuntimeState.allowBackgrounding) {
    return {
      action: "background",
      reason: "managed-popup-window",
    };
  }
  return {
    action: "skip",
    reason: windowRuntimeState.backgroundBlockedReason || "not-applicable",
  };
}

export function sortSlotsForDisplay(
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

export function normalizeExecutionLane(
  lane: unknown,
): LlmProviderExecutionLane {
  const normalized = String(lane || "").trim().toLowerCase();
  if (normalized === "compaction") return "compaction";
  if (normalized === "title") return "title";
  return "primary";
}

export function toSlotLanePreference(
  lane: LlmProviderExecutionLane,
): "primary" | "auxiliary" {
  return lane === "primary" ? "primary" : "auxiliary";
}

export function buildSessionLaneKey(
  sessionId: string,
  lane: LlmProviderExecutionLane,
): string {
  return `${String(sessionId || "").trim()}::${lane}`;
}
