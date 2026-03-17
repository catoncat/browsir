import { useIntervalFn } from "@vueuse/core";
import { onMounted, onUnmounted, ref, type ComputedRef, type Ref } from "vue";
import type { RuntimeEventDigest } from "../types";
import { clipText, toRecord } from "../utils/tool-formatters";

const TOOL_STREAM_SYNC_INTERVAL_MS = 3200;
const BRIDGE_STATUS_SYNC_INTERVAL_MS = 6000;
const RUNTIME_EVENT_MAX = 220;

interface RuntimeHookResult {
  blocked: boolean;
  reason?: string;
  value: Record<string, unknown>;
}

interface PanelUiRuntimeLike {
  runHook: (hookName: string, payload: unknown) => Promise<RuntimeHookResult>;
  getUiStateSnapshot: () => unknown;
  attachHostSlot: (slotId: string, element: HTMLElement) => Promise<void>;
}

export interface RuntimeMessagesDeps {
  activeSessionId: Ref<string>;
  isRunActive: ComputedRef<boolean>;
  chatSceneOverlayRef: Ref<HTMLElement | null>;
  panelUiRuntime: PanelUiRuntimeLike;
  hydratePanelUiPlugins: () => Promise<void>;
  applyUiExtensionLifecycleMessage: (type: string, payload: unknown) => Promise<boolean>;
  showActionNoticeWithPlugins: (payload: unknown) => Promise<void>;
  applyRuntimeEventToolRun: (event: unknown) => void;
  applyBridgeEventToolOutput: (event: unknown) => void;
  syncActiveToolRun: (sessionId: string) => Promise<void>;
  runSafely: (task: () => Promise<void>, fallback: string) => Promise<void>;
  loadConversation: (sessionId: string, options: { setActive: boolean }) => Promise<void>;
  refreshSessions: () => Promise<void>;
}

export function useRuntimeMessages(deps: RuntimeMessagesDeps) {
  const bridgeConnectionStatus = ref<"unknown" | "connected" | "disconnected">("unknown");
  const recentRuntimeEvents = ref<RuntimeEventDigest[]>([]);

  function pushRecentRuntimeEvent(source: "brain" | "bridge", event: unknown) {
    const row = toRecord(event);
    const payload = toRecord(row.payload || row.data);
    const type = String(row.type || row.event || "").trim() || "unknown";
    const ts = String(row.ts || row.timestamp || new Date().toISOString());
    const sessionId = String(row.sessionId || "").trim();
    const preview = clipText(
      String(
        payload.error ||
          payload.message ||
          payload.action ||
          payload.arguments ||
          payload.reason ||
          payload.chunk ||
          "",
      ),
      180,
    );
    const merged = [
      ...recentRuntimeEvents.value,
      { source, ts, type, preview, sessionId },
    ];
    if (merged.length > RUNTIME_EVENT_MAX) {
      merged.splice(0, merged.length - RUNTIME_EVENT_MAX);
    }
    recentRuntimeEvents.value = merged;
  }

  async function refreshBridgeConnectionStatus() {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "bridge.connect",
        force: false,
      })) as { ok?: boolean };
      bridgeConnectionStatus.value = response?.ok ? "connected" : "disconnected";
    } catch {
      bridgeConnectionStatus.value = "disconnected";
    }
  }

  async function handleRuntimeMessage(message: unknown) {
    const msgType = String(toRecord(message).type || "").trim();

    if (msgType === "bbloop.plugin.trace" || msgType.startsWith("sandbox-")) return;

    const runtimeHook = await deps.panelUiRuntime.runHook("ui.runtime.event", {
      type: msgType,
      message,
    });
    if (runtimeHook.blocked) return;

    const payload = toRecord(runtimeHook.value.message) as {
      type?: string;
      status?: string;
      event?: { sessionId?: string; type?: string; payload?: unknown };
      payload?: { sessionId?: string; event?: string; data?: Record<string, unknown> };
    };

    const type = String(payload?.type || "").trim();
    if (!type) return;

    if (type.startsWith("brain.plugin.ui_extension.")) {
      await deps.applyUiExtensionLifecycleMessage(type, payload.payload);
      return;
    }

    if (type === "bbloop.global.message") {
      await deps.showActionNoticeWithPlugins(payload.payload);
      return;
    }

    if (type === "bridge.status") {
      const status = String(payload.status || "").trim();
      bridgeConnectionStatus.value =
        status === "connected" ? "connected" : "disconnected";
      return;
    }

    if (type === "bridge.event") {
      bridgeConnectionStatus.value = "connected";
      if (payload.payload) {
        pushRecentRuntimeEvent("bridge", payload.payload);
      }
      deps.applyBridgeEventToolOutput(payload.payload);
      return;
    }

    if (type !== "brain.event") return;
    if (payload.event) {
      pushRecentRuntimeEvent("brain", payload.event);
    }
    const brainEventType = String(payload?.event?.type || "").trim();
    if (brainEventType === "plugin.global_message") {
      await deps.showActionNoticeWithPlugins(payload?.event?.payload);
    }
    const eventSessionId = String(payload?.event?.sessionId || "").trim();
    if (!eventSessionId) return;

    if (eventSessionId === deps.activeSessionId.value) {
      deps.applyRuntimeEventToolRun(payload.event);
      void deps.runSafely(
        async () => {
          await deps.loadConversation(eventSessionId, { setActive: false });
          if (brainEventType === "session_title_auto_updated") {
            await deps.refreshSessions();
          }
        },
        "刷新会话失败",
      );
      return;
    }

    void deps.runSafely(() => deps.refreshSessions(), "刷新会话列表失败");
  }

  const onRuntimeMessage = (message: unknown) => {
    void handleRuntimeMessage(message).catch((error) => {
      console.error("runtime message handling failed", error);
    });
  };

  const onUiStateQuery = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    const msg = message as Record<string, unknown> | undefined;
    if (msg?.type === "bbloop.ui.state.query") {
      sendResponse({ ok: true, data: deps.panelUiRuntime.getUiStateSnapshot() });
      return false;
    }
    return false;
  };

  onMounted(() => {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.runtime.onMessage.addListener(onUiStateQuery);
    void deps.runSafely(async () => {
      if (deps.chatSceneOverlayRef.value) {
        await deps.panelUiRuntime.attachHostSlot(
          "chat.scene.overlay",
          deps.chatSceneOverlayRef.value,
        );
      }
      await deps.hydratePanelUiPlugins();
      await refreshBridgeConnectionStatus();
      if (deps.activeSessionId.value && deps.isRunActive.value) {
        await deps.syncActiveToolRun(deps.activeSessionId.value);
      }
    }, "初始化失败");
  });

  onUnmounted(() => {
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    chrome.runtime.onMessage.removeListener(onUiStateQuery);
    recentRuntimeEvents.value = [];
  });

  useIntervalFn(() => {
    if (!deps.activeSessionId.value || !deps.isRunActive.value) return;
    void deps.runSafely(
      async () => {
        await Promise.all([
          deps.loadConversation(deps.activeSessionId.value, { setActive: false }),
          deps.syncActiveToolRun(deps.activeSessionId.value),
        ]);
      },
      "轮询会话失败",
    );
  }, TOOL_STREAM_SYNC_INTERVAL_MS);

  useIntervalFn(() => {
    void refreshBridgeConnectionStatus();
  }, BRIDGE_STATUS_SYNC_INTERVAL_MS);

  return {
    bridgeConnectionStatus,
    recentRuntimeEvents,
    refreshBridgeConnectionStatus,
  };
}
