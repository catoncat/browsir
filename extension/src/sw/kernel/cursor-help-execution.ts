import {
  serializeHostedChatTransportEvent,
  type HostedChatTransportEvent,
} from "../../shared/cursor-help-web-shared";
import type { LlmProviderExecutionLane } from "./llm-provider";
import type { CursorHelpSlotRecord } from "./cursor-help-pool-policy";
import { buildSessionLaneKey } from "./cursor-help-pool-policy";
import { loadCursorHelpPoolState, patchCursorHelpSlotState } from "./cursor-help-pool-state";

export interface PendingExecution {
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

export const ACTIVE_BY_REQUEST_ID = new Map<string, PendingExecution>();
export const ACTIVE_REQUEST_ID_BY_SLOT = new Map<string, string>();
export const ACTIVE_REQUEST_ID_BY_TAB = new Map<number, string>();
export const ACTIVE_REQUEST_ID_BY_SESSION_LANE = new Map<string, string>();

export const EXECUTION_BOOT_TIMEOUT_MS = 20_000;
export const EXECUTION_STALE_MS = 90_000;

const encoder = new TextEncoder();

export function enqueueHostedEvent(entry: PendingExecution, event: HostedChatTransportEvent): void {
  if (entry.closed) return;
  const chunk = encoder.encode(serializeHostedChatTransportEvent(event));
  if (entry.controller) {
    entry.controller.enqueue(chunk);
    return;
  }
  entry.queue.push(chunk);
}

export function releaseExecution(entry: PendingExecution): boolean {
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

export function closeExecution(entry: PendingExecution): void {
  if (!releaseExecution(entry)) return;
  void loadCursorHelpPoolState().then((poolState) => {
    const currentSlot = poolState.slots.find((s) => s.slotId === entry.slotId);
    if (currentSlot?.status === "recovering") return;
    return patchCursorHelpSlotState(entry.slotId, {
      status: "idle",
      lastUsedAt: Date.now(),
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

export function failExecution(entry: PendingExecution, error: string): void {
  if (!releaseExecution(entry)) return;
  if (entry.startedAt === null) {
    void patchCursorHelpSlotState(entry.slotId, {
      status: "stale",
      lastUsedAt: Date.now(),
      lastError: error,
    }).catch((patchErr) => {
      console.warn(`[web-chat-executor] failExecution: patchSlotState(stale) failed for slot=${entry.slotId}`, patchErr);
    });
  } else {
    void patchCursorHelpSlotState(entry.slotId, {
      status: "error",
      lastUsedAt: Date.now(),
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

export function touchExecution(entry: PendingExecution): void {
  entry.lastEventAt = Date.now();
}

export function armExecutionWatchdog(entry: PendingExecution, timeoutMs: number, reason: string): void {
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
  }
  entry.timeoutHandle = setTimeout(() => {
    failExecution(entry, reason);
  }, timeoutMs);
}

export function clearStaleExecution(slotId: string, tabId: number): void {
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
      failExecution(entry, "请求启动超时，请稍后重试。");
      continue;
    }
    if (Date.now() - entry.lastEventAt < EXECUTION_STALE_MS) continue;
    failExecution(entry, "请求超时，请稍后重试。");
  }
}

export function reapStaleExecutionsForSlots(
  slots: CursorHelpSlotRecord[],
): void {
  for (const slot of slots) {
    clearStaleExecution(slot.slotId, slot.tabId);
  }
}
