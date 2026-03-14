import { computed, nextTick, watch, type ComputedRef, type Ref } from "vue";
import type { DisplayMessage } from "../types";
import type { ToolPendingStepState } from "../utils/tool-formatters";

const MAIN_SCROLL_BOTTOM_THRESHOLD_PX = 120;

export interface ChatScrollSyncDeps {
  scrollContainer: Ref<HTMLElement | null>;
  stableMessages: Ref<DisplayMessage[]>;
  shouldShowStreamingDraft: ComputedRef<boolean>;
  activeSessionId: Ref<string>;
  activeRunToken: Ref<number>;
  shouldShowToolPendingCard: ComputedRef<boolean>;
  llmStreamingText: Ref<string>;
  isRunActive: ComputedRef<boolean>;
  toolPendingStepStates: Ref<ToolPendingStepState[]>;
}

export function useChatScrollSync(deps: ChatScrollSyncDeps) {
  function isMainScrollNearBottom() {
    const el = deps.scrollContainer.value;
    if (!el) return true;
    const remain = el.scrollHeight - el.scrollTop - el.clientHeight;
    return remain <= MAIN_SCROLL_BOTTOM_THRESHOLD_PX;
  }

  const visibleMessageStructureKey = computed(() =>
    [
      deps.stableMessages.value.map((item) => `${item.role}:${item.entryId}`).join("|"),
      deps.shouldShowStreamingDraft.value
        ? `draft:${String(deps.activeSessionId.value || "__global__")}:${deps.activeRunToken.value}`
        : "",
      deps.shouldShowToolPendingCard.value
        ? `tool:${String(deps.activeSessionId.value || "__global__")}:${deps.activeRunToken.value}`
        : "",
    ].join("|"),
  );

  async function followScrollIfNeeded() {
    const shouldFollow = isMainScrollNearBottom();
    await nextTick();
    if (shouldFollow && deps.scrollContainer.value) {
      deps.scrollContainer.value.scrollTop = deps.scrollContainer.value.scrollHeight;
    }
  }

  watch(visibleMessageStructureKey, async () => {
    await followScrollIfNeeded();
  });

  watch(deps.llmStreamingText, async () => {
    if (!deps.isRunActive.value) return;
    await followScrollIfNeeded();
  });

  watch(
    () =>
      deps.toolPendingStepStates.value
        .map((item) => `${item.step}:${item.status}:${item.logs.length}`)
        .join("|"),
    async () => {
      if (!deps.isRunActive.value) return;
      await followScrollIfNeeded();
    },
  );

  return {
    visibleMessageStructureKey,
    isMainScrollNearBottom,
    followScrollIfNeeded,
  };
}
