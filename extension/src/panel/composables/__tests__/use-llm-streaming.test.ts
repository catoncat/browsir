// @vitest-environment happy-dom
import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";
import { useLlmStreaming } from "../use-llm-streaming";
import type { DisplayMessage, RunViewPhase } from "../../types";

function createHarness() {
  const isRunActive = ref(true);
  const activeSessionId = ref("session-1");
  const messages = ref<DisplayMessage[]>([]);
  const runPhaseRef = ref<RunViewPhase>("llm");
  const startRunPending = ref(false);
  const shouldShowToolPendingCard = ref(false);

  const streaming = useLlmStreaming({
    isRunActive: computed(() => isRunActive.value),
    activeSessionId,
    messages,
    runPhase: computed(() => runPhaseRef.value),
    startRunPending,
    shouldShowToolPendingCard: computed(() => shouldShowToolPendingCard.value),
  });

  return {
    isRunActive,
    activeSessionId,
    messages,
    runPhaseRef,
    startRunPending,
    shouldShowToolPendingCard,
    ...streaming,
  };
}

describe("useLlmStreaming", () => {
  it("resets streaming state when tool_call_detected arrives (text persisted via content blocks)", () => {
    const harness = createHarness();
    harness.applyStreamEvent("hosted_chat.debug", {}, "session-1");
    harness.applyStreamEvent(
      "hosted_chat.stream_text_delta",
      { text: "我先去找输入框。" },
      "session-1",
    );

    const result = harness.applyStreamEvent(
      "hosted_chat.tool_call_detected",
      {},
      "session-1",
    );

    expect(result.handled).toBe(true);
    expect(harness.llmStreamingText.value).toBe("");
    expect(harness.llmStreamingActive.value).toBe(false);
    expect(harness.shouldShowStreamingDraft.value).toBe(false);
  });

  it("resets streaming state when turn_resolved ends in tool_calls", () => {
    const harness = createHarness();
    harness.applyStreamEvent("hosted_chat.debug", {}, "session-1");
    harness.applyStreamEvent(
      "hosted_chat.stream_text_delta",
      { text: "我先滚动页面再继续。" },
      "session-1",
    );

    const result = harness.applyStreamEvent(
      "hosted_chat.turn_resolved",
      { finishReason: "tool_calls" },
      "session-1",
    );

    expect(result.handled).toBe(true);
    expect(harness.llmStreamingText.value).toBe("");
    expect(harness.llmStreamingActive.value).toBe(false);
    expect(harness.shouldShowStreamingDraft.value).toBe(false);
  });

  it("resets streaming state when parsed response contains tool calls", () => {
    const harness = createHarness();
    harness.applyStreamEvent("llm.stream.start", {}, "session-1");
    harness.applyStreamEvent(
      "llm.stream.delta",
      { text: "我先读取页面结构。" },
      "session-1",
    );

    const result = harness.applyStreamEvent(
      "llm.response.parsed",
      { toolCalls: 1, source: "llm_provider" },
      "session-1",
    );

    expect(result.handled).toBe(true);
    expect(harness.llmStreamingText.value).toBe("");
    expect(harness.llmStreamingActive.value).toBe(false);
    expect(harness.shouldShowStreamingDraft.value).toBe(false);
  });
});
