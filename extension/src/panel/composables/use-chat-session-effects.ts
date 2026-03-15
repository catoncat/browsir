import {
  onUnmounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
  type WritableComputedRef,
} from "vue";
import type { QueuedPromptViewItem, RunViewPhase } from "../types";
import { toRecord } from "../utils/tool-formatters";

export interface ChatSessionEffectsDeps {
  queuedPromptViewItems: ComputedRef<QueuedPromptViewItem[]>;
  queuedPromotingIds: Ref<Set<string>>;
  isRunActive: ComputedRef<boolean>;
  runPhase: WritableComputedRef<RunViewPhase>;
  activeRunToken: Ref<number>;
  activeSessionId: Ref<string>;
  activeSession: ComputedRef<{ forkedFrom?: { sessionId?: string } | null } | null>;
  activeForkSourceSessionId: ComputedRef<string>;
  activeForkSourceSession: ComputedRef<{ title?: string } | null>;
  hasToolPendingActivity: ComputedRef<boolean>;
  hasRunningToolPendingActivity: ComputedRef<boolean>;
  llmStreamingActive: Ref<boolean>;
  llmStreamingText: Ref<string>;
  finalAssistantStreamingPhase: WritableComputedRef<boolean>;
  pendingRegenerate: Ref<unknown>;
  userPendingRegenerate: Ref<unknown>;
  messages: Ref<Array<{ entryId?: string }>>;
  editingUserEntryId: Ref<string>;
  startRunPending: Ref<boolean>;
  clearToolPendingSteps: () => void;
  clearActiveToolRun: () => void;
  resetToolPendingCardHandoff: () => void;
  dismissToolPendingCardWithHandoff: () => void;
  startInitialToolSync: () => void;
  stopInitialToolSync: () => void;
  syncActiveToolRun: (sessionId: string) => Promise<void>;
  resetLlmStreamingState: () => void;
  clearRunHint: () => void;
  setLlmRunHint: (label: string, detail?: string) => void;
  resetEditingState: () => void;
  isExpectedForkSwitch: (sessionId: string) => boolean;
  bumpForkSceneToken: () => number;
  resetForkSceneState: () => void;
  setForkSessionHighlight: (value: boolean) => void;
  runSafely: (task: () => Promise<void>, fallback: string) => Promise<void>;
  notifyActiveSessionChanged: (nextId?: string, prevId?: string) => Promise<void>;
  emitUiSessionChanged: (payload: {
    sessionId: string;
    previousSessionId: string;
    reason: string;
  }) => Promise<void>;
}

export function useChatSessionEffects(deps: ChatSessionEffectsDeps) {
  const forkSourceResolvedTitle = ref("");
  let disposed = false;
  onUnmounted(() => { disposed = true; });

  watch(deps.queuedPromptViewItems, (items) => {
    if (!deps.queuedPromotingIds.value.size) return;
    const valid = new Set(items.map((item) => item.id));
    let changed = false;
    const next = new Set<string>();
    for (const id of deps.queuedPromotingIds.value) {
      if (valid.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) {
      deps.queuedPromotingIds.value = next;
    }
  });

  watch(deps.isRunActive, (running, wasRunning) => {
    if (running) {
      deps.startRunPending.value = false;
      if (deps.runPhase.value === "idle") {
        deps.runPhase.value = "llm";
      }
      deps.resetToolPendingCardHandoff();
      if (!wasRunning) {
        deps.activeRunToken.value += 1;
        deps.clearToolPendingSteps();
      }
      deps.setLlmRunHint("思考中", "正在分析你的请求");
      if (deps.activeSessionId.value) {
        void deps.runSafely(
          async () => {
            await deps.syncActiveToolRun(deps.activeSessionId.value);
            if (disposed) return;
          },
          "同步工具运行状态失败",
        );
      }
      deps.startInitialToolSync();
      return;
    }
    deps.stopInitialToolSync();
    deps.resetToolPendingCardHandoff();
    deps.userPendingRegenerate.value = null;
    deps.runPhase.value = "idle";
    deps.clearActiveToolRun();
    deps.clearToolPendingSteps();
    deps.resetLlmStreamingState();
    deps.clearRunHint();
  });

  watch(deps.activeSessionId, (nextSessionId, previousSessionId) => {
    deps.queuedPromotingIds.value = new Set();
    deps.stopInitialToolSync();
    deps.resetToolPendingCardHandoff();
    deps.runPhase.value = deps.isRunActive.value ? "llm" : "idle";
    const currentSessionId = String(deps.activeSessionId.value || "").trim();
    const isExpectedSwitch = deps.isExpectedForkSwitch(currentSessionId);
    if (!isExpectedSwitch) {
      deps.bumpForkSceneToken();
      deps.resetForkSceneState();
    }
    deps.clearActiveToolRun();
    deps.clearToolPendingSteps();
    deps.resetLlmStreamingState();
    deps.clearRunHint();
    if (!deps.activeSession.value?.forkedFrom?.sessionId) {
      deps.setForkSessionHighlight(false);
    }
    deps.resetEditingState();
    if (deps.activeSessionId.value && deps.isRunActive.value) {
      void deps.runSafely(
        async () => {
          await deps.syncActiveToolRun(deps.activeSessionId.value);
          if (disposed) return;
        },
        "同步工具运行状态失败",
      );
      deps.startInitialToolSync();
    }
    const nextId = String(nextSessionId || "").trim();
    const prevId = String(previousSessionId || "").trim();
    void deps.notifyActiveSessionChanged(nextId || undefined, prevId || undefined);
    void deps.emitUiSessionChanged({
      sessionId: nextId,
      previousSessionId: prevId,
      reason: "active_session_changed",
    });
  });

  watch(
    [
      deps.isRunActive,
      deps.hasToolPendingActivity,
      deps.hasRunningToolPendingActivity,
      deps.llmStreamingActive,
      deps.llmStreamingText,
      deps.finalAssistantStreamingPhase,
    ],
    ([running, hasActivity, hasRunningTool, streamingActive, streamingText, finalPhase]) => {
      if (!running || !hasActivity) return;
      if (hasRunningTool) {
        deps.resetToolPendingCardHandoff();
        deps.stopInitialToolSync();
        return;
      }
      if (!finalPhase) return;
      const hasStreaming = streamingActive || Boolean(String(streamingText || "").trim());
      if (hasStreaming) {
        deps.dismissToolPendingCardWithHandoff();
      }
    },
  );

  watch(
    [() => deps.pendingRegenerate.value, () => deps.userPendingRegenerate.value],
    ([assistantPending, userPending]) => {
      if (!assistantPending && !userPending) return;
      deps.resetToolPendingCardHandoff();
      deps.clearActiveToolRun();
      deps.clearToolPendingSteps();
      deps.finalAssistantStreamingPhase.value = false;
      deps.runPhase.value = "llm";
      if (deps.isRunActive.value) {
        deps.startInitialToolSync();
      }
    },
  );

  watch(
    deps.messages,
    (list) => {
      if (!deps.editingUserEntryId.value) return;
      const exists = list.some(
        (item) => String(item?.entryId || "") === deps.editingUserEntryId.value,
      );
      if (!exists) deps.resetEditingState();
    },
    { deep: true },
  );

  watch(
    [deps.activeForkSourceSessionId, deps.activeForkSourceSession],
    async ([sourceId, sourceSession]) => {
      const id = String(sourceId || "").trim();
      if (!id) {
        forkSourceResolvedTitle.value = "";
        return;
      }

      const titleInList = String(sourceSession?.title || "").trim();
      if (titleInList) {
        forkSourceResolvedTitle.value = "";
        return;
      }

      try {
        const response = (await chrome.runtime.sendMessage({
          type: "brain.session.get",
          sessionId: id,
        })) as { ok?: boolean; data?: Record<string, unknown> };
        if (deps.activeForkSourceSessionId.value !== id) return;
        if (response?.ok !== true) return;
        const meta = toRecord(response.data?.meta);
        const header = toRecord(meta.header);
        const title = String(header.title || "").trim();
        forkSourceResolvedTitle.value = title;
      } catch {
        // 忽略来源标题查询失败，继续使用兜底文案。
      }
    },
    { immediate: true },
  );

  return {
    forkSourceResolvedTitle,
  };
}
