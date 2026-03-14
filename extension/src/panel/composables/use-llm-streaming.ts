import { ref, computed, type Ref, type ComputedRef } from "vue";
import type { DisplayMessage, RunViewPhase } from "../types";

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

  let llmStreamFlushRaf: number | null = null;
  let llmStreamingDeltaBuffer = "";

  function flushLlmStreamingDeltaBuffer() {
    if (!llmStreamingDeltaBuffer) return;
    llmStreamingPendingText.value = `${llmStreamingPendingText.value}${llmStreamingDeltaBuffer}`;
    llmStreamingDeltaBuffer = "";
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
    llmStreamingDeltaBuffer += text;
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
    llmStreamingDeltaBuffer = "";
    llmStreamingPendingText.value = "";
    llmStreamingText.value = "";
    llmStreamingSessionId.value = "";
    llmStreamingActive.value = false;
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

  function cleanup() {
    if (llmStreamFlushRaf != null) {
      cancelAnimationFrame(llmStreamFlushRaf);
      llmStreamFlushRaf = null;
    }
    llmStreamingDeltaBuffer = "";
  }

  return {
    llmStreamingText,
    llmStreamingSessionId,
    llmStreamingActive,
    llmStreamingPendingText,
    shouldShowStreamingDraft,
    shouldShowStartPendingDraft,
    flushLlmStreamingDeltaBuffer,
    appendLlmStreamingDelta,
    commitPendingLlmStreamingText,
    resetLlmStreamingState,
    cleanup,
  };
}
