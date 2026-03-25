import { ref, computed, type Ref, type ComputedRef } from "vue";
import type { DisplayMessage, RunViewPhase } from "../types";
import {
  appendRunTimelineText,
  cloneRunTimelineItems,
  type RunTimelineItem,
  upsertRunTimelineToolItem,
} from "../utils/run-timeline";
import type { ToolPendingStepState } from "../utils/tool-formatters";

export interface LlmStreamEventResult {
  handled: boolean;
  runPhase?: RunViewPhase;
  hint?: { label: string; detail: string };
  finalAssistant?: boolean;
}

export interface LlmStreamingDeps {
  isRunActive: ComputedRef<boolean>;
  activeSessionId: Ref<string>;
  messages: Ref<DisplayMessage[]>;
  runPhase: ComputedRef<RunViewPhase>;
  startRunPending: Ref<boolean>;
  shouldShowToolPendingCard: ComputedRef<boolean>;
}

export function useLlmStreaming(deps: LlmStreamingDeps) {
  const llmStreamingText = ref("");
  const llmStreamingSessionId = ref("");
  const llmStreamingActive = ref(false);
  const llmStreamingPendingText = ref("");
  const liveRunTimelineItems = ref<RunTimelineItem[]>([]);

  let llmStreamFlushRaf: number | null = null;
  let llmStreamingDeltaBuffer: string[] = [];

  function flushLlmStreamingDeltaBuffer() {
    if (llmStreamingDeltaBuffer.length === 0) return;
    llmStreamingPendingText.value += llmStreamingDeltaBuffer.join("");
    llmStreamingDeltaBuffer = [];
  }

  function scheduleLlmStreamingFlush() {
    if (llmStreamFlushRaf != null) return;
    llmStreamFlushRaf = requestAnimationFrame(() => {
      llmStreamFlushRaf = null;
      flushLlmStreamingDeltaBuffer();
    });
  }

  function appendLlmStreamingDelta(chunk: string) {
    const text = String(chunk || "");
    if (!text) return;
    llmStreamingDeltaBuffer.push(text);
    scheduleLlmStreamingFlush();
  }

  function commitPendingLlmStreamingText() {
    flushLlmStreamingDeltaBuffer();
    llmStreamingText.value = llmStreamingPendingText.value;
  }

  /** Resets only LLM-owned streaming state. Caller is responsible for finalAssistantStreamingPhase. */
  function resetLlmStreamingState() {
    if (llmStreamFlushRaf != null) {
      cancelAnimationFrame(llmStreamFlushRaf);
      llmStreamFlushRaf = null;
    }
    llmStreamingDeltaBuffer = [];
    llmStreamingPendingText.value = "";
    llmStreamingText.value = "";
    llmStreamingSessionId.value = "";
    llmStreamingActive.value = false;
  }

  /** 将当前流式文本冻结到独立列表，然后完全重置流式状态。 */
  function freezeAndResetStreaming(explicitText?: string) {
    flushLlmStreamingDeltaBuffer();
    commitPendingLlmStreamingText();
    const text = String(explicitText || "").trim() || llmStreamingText.value.trim();
    liveRunTimelineItems.value = appendRunTimelineText(
      liveRunTimelineItems.value,
      text,
    );
    resetLlmStreamingState();
  }

  /** 清除冻结文本（仅在 loop 终态/重启时调用）。 */
  function clearFrozenPreToolText() {
    liveRunTimelineItems.value = [];
  }

  function clearLiveRunTimeline() {
    clearFrozenPreToolText();
  }

  function getLiveRunTimelineItems(): RunTimelineItem[] {
    return cloneRunTimelineItems(liveRunTimelineItems.value);
  }

  function upsertLiveRunTimelineToolStep(step: ToolPendingStepState) {
    liveRunTimelineItems.value = upsertRunTimelineToolItem(
      liveRunTimelineItems.value,
      step,
    );
  }

  const shouldShowStreamingDraft = computed(() => {
    if (!deps.isRunActive.value) return false;

    const sourceSessionId = String(llmStreamingSessionId.value || "").trim();
    const currentSessionId = String(deps.activeSessionId.value || "").trim();
    if (sourceSessionId && currentSessionId && sourceSessionId !== currentSessionId) {
      return false;
    }

    const text = String(llmStreamingText.value || "");
    const normalizedText = text.trim();

    if (llmStreamingActive.value) {
      if (deps.runPhase.value === "tool_running" || deps.runPhase.value === "tool_handoff_leaving") {
        return normalizedText.length > 0;
      }
      return true;
    }

    if (!normalizedText) {
      return false;
    }

    for (let i = deps.messages.value.length - 1; i >= 0; i -= 1) {
      const item = deps.messages.value[i];
      if (String(item?.role || "") !== "assistant") continue;
      const content = String(item?.content || "").trim();
      if (!content) continue;
      if (content === normalizedText) return false;
      break;
    }

    return true;
  });

  const shouldShowStartPendingDraft = computed(() =>
    deps.startRunPending.value &&
    !deps.isRunActive.value &&
    !shouldShowStreamingDraft.value &&
    !deps.shouldShowToolPendingCard.value
  );

  const shouldShowFrozenPreToolText = computed(() => {
    if (!deps.isRunActive.value) return false;
    return liveRunTimelineItems.value.length > 0;
  });

  function applyStreamEvent(
    type: string,
    payload: Record<string, unknown>,
    eventSessionId: string,
  ): LlmStreamEventResult {
    const fallbackSessionId = eventSessionId || String(deps.activeSessionId.value || "");

    if (type === "hosted_chat.debug") {
      flushLlmStreamingDeltaBuffer();
      llmStreamingPendingText.value = "";
      llmStreamingText.value = "";
      llmStreamingSessionId.value = fallbackSessionId;
      llmStreamingActive.value = true;
      return {
        handled: true,
        runPhase: "llm",
        finalAssistant: false,
        hint: { label: "宿主生成中", detail: "正在接管网页会话" },
      };
    }

    if (type === "hosted_chat.stream_text_delta") {
      const chunk = String(payload.text || "");
      if (chunk) {
        if (!llmStreamingActive.value) {
          llmStreamingSessionId.value = fallbackSessionId;
          llmStreamingActive.value = true;
        }
        appendLlmStreamingDelta(chunk);
        commitPendingLlmStreamingText();
        const committed = llmStreamingText.value;
        const markerIdx = committed.indexOf("[TM_TOOL_CALL_START:");
        if (markerIdx >= 0) {
          llmStreamingText.value = committed.slice(0, markerIdx).trimEnd();
          llmStreamingPendingText.value = llmStreamingText.value;
        }
      }
      return {
        handled: true,
        runPhase: "llm",
        finalAssistant: false,
        hint: { label: "宿主生成中", detail: "正在等待网页会话完成当前回合" },
      };
    }

    if (type === "hosted_chat.tool_call_detected") {
      freezeAndResetStreaming(String(payload.assistantText || ""));
      return {
        handled: true,
        runPhase: "llm",
        finalAssistant: false,
        hint: { label: "检测到工具计划", detail: "即将进入工具执行" },
      };
    }

    if (type === "hosted_chat.turn_resolved") {
      const finishReason = String(payload.finishReason || "").trim();
      if (finishReason === "tool_calls") {
        const resolvedText =
          typeof payload.assistantText === "string"
            ? payload.assistantText
            : String((payload.result as Record<string, unknown> | undefined)?.assistantText || "");
        freezeAndResetStreaming(resolvedText);
        return {
          handled: true,
          runPhase: "llm",
          finalAssistant: false,
          hint: { label: "准备执行工具", detail: "宿主回合已完成，正在交给工具执行" },
        };
      }
      flushLlmStreamingDeltaBuffer();
      commitPendingLlmStreamingText();
      llmStreamingActive.value = false;
      return {
        handled: true,
        finalAssistant: true,
        hint: { label: "整理回复", detail: "正在整理网页会话结果" },
      };
    }

    if (type === "hosted_chat.transport_error") {
      resetLlmStreamingState();
      return { handled: true, finalAssistant: false };
    }

    if (type === "llm.stream.start") {
      flushLlmStreamingDeltaBuffer();
      llmStreamingPendingText.value = "";
      llmStreamingText.value = "";
      llmStreamingSessionId.value = fallbackSessionId;
      llmStreamingActive.value = true;
      return {
        handled: true,
        runPhase: "llm",
        finalAssistant: false,
        hint: { label: "思考中", detail: "正在规划下一步" },
      };
    }

    if (type === "llm.stream.delta") {
      const chunk = String(payload.text || "");
      if (!chunk) return { handled: true };
      const activeId = String(deps.activeSessionId.value || "").trim();
      const sourceId = llmStreamingSessionId.value || eventSessionId;
      if (sourceId && activeId && sourceId !== activeId) return { handled: true };
      llmStreamingSessionId.value = sourceId || activeId;
      appendLlmStreamingDelta(chunk);
      llmStreamingActive.value = true;
      return { handled: true };
    }

    if (type === "llm.stream.end") {
      flushLlmStreamingDeltaBuffer();
      llmStreamingActive.value = false;
      return { handled: true };
    }

    if (type === "llm.response.parsed") {
      flushLlmStreamingDeltaBuffer();
      const toolCalls = Number(payload.toolCalls || 0);
      const responseSource = String(payload.source || "").trim();
      const isHostedTransport = responseSource === "hosted_chat_transport";
      if (Number.isFinite(toolCalls) && toolCalls > 0) {
        freezeAndResetStreaming();
        return {
          handled: true,
          runPhase: "llm",
          finalAssistant: false,
        };
      }
      flushLlmStreamingDeltaBuffer();
      commitPendingLlmStreamingText();
      llmStreamingActive.value = false;
      return {
        handled: true,
        finalAssistant: true,
        hint: {
          label: "整理回复",
          detail: isHostedTransport
            ? "正在生成网页宿主聊天的最终回答"
            : "正在生成最终回答",
        },
      };
    }

    return { handled: false };
  }

  function cleanup() {
    if (llmStreamFlushRaf != null) {
      cancelAnimationFrame(llmStreamFlushRaf);
      llmStreamFlushRaf = null;
    }
    llmStreamingDeltaBuffer = [];
    liveRunTimelineItems.value = [];
  }

  return {
    llmStreamingText,
    llmStreamingSessionId,
    llmStreamingActive,
    llmStreamingPendingText,
    liveRunTimelineItems,
    shouldShowStreamingDraft,
    shouldShowStartPendingDraft,
    shouldShowFrozenPreToolText,
    flushLlmStreamingDeltaBuffer,
    appendLlmStreamingDelta,
    commitPendingLlmStreamingText,
    freezeAndResetStreaming,
    clearFrozenPreToolText,
    clearLiveRunTimeline,
    getLiveRunTimelineItems,
    upsertLiveRunTimelineToolStep,
    resetLlmStreamingState,
    applyStreamEvent,
    cleanup,
  };
}
