import {
  buildCursorHelpCompiledPrompt,
  extractLastUserMessage,
  parseHostedChatTransportEvent,
} from "../../shared/cursor-help-web-shared";
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
import {
  type CursorHelpInspectResult,
  canCursorHelpSlotBootExecute,
  formatInspectFailure,
  classifyInspectHealth,
  buildSlotHealthSnapshot,
  getRecoveryBudget,
} from "./cursor-help-health";
import {
  loadCursorHelpPoolState,
  saveCursorHelpPoolState,
  patchCursorHelpSlotState,
} from "./cursor-help-pool-state";
import {
  type PendingExecution,
  ACTIVE_BY_REQUEST_ID,
  ACTIVE_REQUEST_ID_BY_SLOT,
  ACTIVE_REQUEST_ID_BY_TAB,
  ACTIVE_REQUEST_ID_BY_SESSION_LANE,
  EXECUTION_BOOT_TIMEOUT_MS,
  EXECUTION_STALE_MS,
  enqueueHostedEvent,
  closeExecution,
  failExecution,
  touchExecution,
  armExecutionWatchdog,
  clearStaleExecution,
  reapStaleExecutionsForSlots,
} from "./cursor-help-execution";
import {
  CURSOR_HELP_URL,
  isCursorHelpUrl,
  sendTabMessageWithRetry,
  inspectCursorTab,
  injectCursorHelpScripts,
  inspectCursorTabEnsured,
  waitForCursorHelpTabReady,
  waitForCursorHelpInspectReady,
  markCursorHelpTabStable,
  isCursorHelpWindowAlive,
  minimizeCursorHelpWindow,
  readLiveCursorHelpSlot,
  clearLegacySessionSlots,
} from "./cursor-help-tab-ops";
import {
  DEFAULT_CURSOR_HELP_POOL_SLOT_COUNT,
  MIN_CURSOR_HELP_POOL_SLOT_COUNT,
  MAX_CURSOR_HELP_POOL_SLOT_COUNT,
  normalizePoolSlotCount,
  buildCursorHelpSlotRecord,
  tryAdoptExistingCursorHelpSlots,
  createCursorHelpPoolWindow,
  createAdditionalPoolSlot,
  collectCursorHelpTabDecisionTrace,
} from "./cursor-help-pool-window";
import {
  PREFERRED_SLOT_ID_BY_SESSION,
  PREFERRED_SLOT_ID_BY_CONVERSATION,
  LAST_CONVERSATION_KEY_BY_SESSION,
  clearSlotPreferences,
  clearSessionPreferences,
  hasSlotAffinity,
} from "./cursor-help-slot-preferences";
import {
  markCursorHelpSlotBusy,
  ensureCursorHelpSlotUsable,
  attemptCursorHelpSlotRecovery,
  attemptCursorHelpSlotSoftRecovery,
} from "./cursor-help-slot-lifecycle";

type JsonRecord = Record<string, unknown>;



interface CursorHelpPoolDebugView {
  summary: JsonRecord;
  window: JsonRecord | null;
  slots: JsonRecord[];
}

const PROVIDER_ID = "cursor_help_web";
const SLOT_WAIT_POLL_MS = 200;
const PRIMARY_SLOT_WAIT_MS = 15_000;
const AUXILIARY_SLOT_WAIT_MS = 10_000;
const CURSOR_HELP_HEARTBEAT_INTERVAL_MS = 30_000;
const CURSOR_HELP_HEARTBEAT_BACKOFF_MS = 60_000;
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
    `convMode=${String(debug.conversationControlMode || "").trim() || "implicit"}`,
    `convId=${String(debug.forcedConversationId || "").trim() || "-"}`,
    `promptHash=${String(debug.compiledPromptHash || "").trim() || "-"}`,
    `promptLen=${Number(debug.compiledPromptLength || 0)}`,
    `origLen=${Number(debug.originalTargetLength || 0)}`,
    `nextLen=${Number(debug.rewrittenTargetLength || 0)}`
  ].join(" ");
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

export async function getCursorHelpModelCatalog(): Promise<{
  selectedModel: string;
  availableModels: string[];
}> {
  const state = await loadCursorHelpPoolState();
  const idleSlot = state.slots.find((s) => s.status === "idle") || state.slots[0];
  if (!idleSlot) return { selectedModel: "", availableModels: [] };
  const inspect = await inspectCursorTab(idleSlot.tabId).catch(() => null);
  return {
    selectedModel: inspect?.selectedModel || "",
    availableModels: inspect?.availableModels || [],
  };
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
