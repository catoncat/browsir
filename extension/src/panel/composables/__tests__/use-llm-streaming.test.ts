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
  it("moves existing hosted text into frozen state when tool_call_detected arrives", () => {
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
    expect(harness.liveRunTimelineItems.value).toHaveLength(1);
    expect(harness.liveRunTimelineItems.value[0]).toMatchObject({
      kind: "text",
      text: "我先去找输入框。",
    });
    expect(harness.shouldShowFrozenPreToolText.value).toBe(true);
    expect(harness.llmStreamingText.value).toBe("");
    expect(harness.llmStreamingActive.value).toBe(false);
    expect(harness.shouldShowStreamingDraft.value).toBe(false);
  });

  it("prefers assistantText from tool_call_detected payload when live buffer is empty", () => {
    const harness = createHarness();
    harness.applyStreamEvent("hosted_chat.debug", {}, "session-1");

    const result = harness.applyStreamEvent(
      "hosted_chat.tool_call_detected",
      { assistantText: "我先去找输入框。" },
      "session-1",
    );

    expect(result.handled).toBe(true);
    expect(harness.liveRunTimelineItems.value[0]).toMatchObject({
      kind: "text",
      text: "我先去找输入框。",
    });
    expect(harness.shouldShowFrozenPreToolText.value).toBe(true);
  });

  it("moves existing hosted text into frozen state when turn_resolved ends in tool_calls", () => {
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
    expect(harness.liveRunTimelineItems.value[0]).toMatchObject({
      kind: "text",
      text: "我先滚动页面再继续。",
    });
    expect(harness.shouldShowFrozenPreToolText.value).toBe(true);
    expect(harness.llmStreamingText.value).toBe("");
    expect(harness.llmStreamingActive.value).toBe(false);
    expect(harness.shouldShowStreamingDraft.value).toBe(false);
  });

  it("can freeze from turn_resolved payload when assistantText is present there", () => {
    const harness = createHarness();
    harness.applyStreamEvent("hosted_chat.debug", {}, "session-1");

    const result = harness.applyStreamEvent(
      "hosted_chat.turn_resolved",
      { finishReason: "tool_calls", assistantText: "我先滚动页面再继续。" },
      "session-1",
    );

    expect(result.handled).toBe(true);
    expect(harness.liveRunTimelineItems.value[0]).toMatchObject({
      kind: "text",
      text: "我先滚动页面再继续。",
    });
    expect(harness.shouldShowFrozenPreToolText.value).toBe(true);
  });

  it("moves standard llm text into frozen state when parsed response contains tool calls", () => {
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
    expect(harness.liveRunTimelineItems.value[0]).toMatchObject({
      kind: "text",
      text: "我先读取页面结构。",
    });
    expect(harness.shouldShowFrozenPreToolText.value).toBe(true);
    expect(harness.llmStreamingText.value).toBe("");
    expect(harness.llmStreamingActive.value).toBe(false);
    expect(harness.shouldShowStreamingDraft.value).toBe(false);
  });

  it("keeps frozen text when a new llm stream starts later in the same run", () => {
    const harness = createHarness();
    harness.applyStreamEvent("hosted_chat.debug", {}, "session-1");
    harness.applyStreamEvent(
      "hosted_chat.stream_text_delta",
      { text: "我先定位输入框。" },
      "session-1",
    );
    harness.applyStreamEvent(
      "hosted_chat.tool_call_detected",
      {},
      "session-1",
    );

    harness.applyStreamEvent("llm.stream.start", {}, "session-1");
    harness.applyStreamEvent(
      "llm.stream.delta",
      { text: "我继续分析工具结果。" },
      "session-1",
    );

    expect(harness.liveRunTimelineItems.value[0]).toMatchObject({
      kind: "text",
      text: "我先定位输入框。",
    });
    expect(harness.shouldShowFrozenPreToolText.value).toBe(true);
    expect(harness.llmStreamingText.value).toBe("");
    expect(harness.llmStreamingActive.value).toBe(true);
  });

  it("accumulates multiple frozen pre-tool texts in order", () => {
    const harness = createHarness();

    harness.applyStreamEvent("hosted_chat.debug", {}, "session-1");
    harness.applyStreamEvent(
      "hosted_chat.tool_call_detected",
      { assistantText: "我先找电影列表。" },
      "session-1",
    );
    harness.applyStreamEvent("llm.stream.start", {}, "session-1");
    harness.applyStreamEvent(
      "hosted_chat.tool_call_detected",
      { assistantText: "我再打开详情页确认一下。" },
      "session-1",
    );

    expect(
      harness.liveRunTimelineItems.value.map((item) =>
        item.kind === "text" ? item.text : item.id,
      ),
    ).toEqual([
      "我先找电影列表。",
      "我再打开详情页确认一下。",
    ]);
    expect(harness.shouldShowFrozenPreToolText.value).toBe(true);
  });

  it("deduplicates repeated freeze attempts for the same text", () => {
    const harness = createHarness();
    harness.applyStreamEvent("hosted_chat.debug", {}, "session-1");

    harness.applyStreamEvent(
      "hosted_chat.tool_call_detected",
      { assistantText: "我先去找输入框。" },
      "session-1",
    );
    harness.applyStreamEvent(
      "hosted_chat.turn_resolved",
      { finishReason: "tool_calls", assistantText: "我先去找输入框。" },
      "session-1",
    );

    expect(harness.liveRunTimelineItems.value).toHaveLength(1);
    expect(harness.liveRunTimelineItems.value[0]).toMatchObject({
      kind: "text",
      text: "我先去找输入框。",
    });
  });

  it("clears frozen text only when explicitly requested", () => {
    const harness = createHarness();
    harness.applyStreamEvent("hosted_chat.debug", {}, "session-1");
    harness.applyStreamEvent(
      "hosted_chat.stream_text_delta",
      { text: "我先查一下页面结构。" },
      "session-1",
    );
    harness.applyStreamEvent(
      "hosted_chat.tool_call_detected",
      {},
      "session-1",
    );

    harness.clearFrozenPreToolText();

    expect(harness.liveRunTimelineItems.value).toEqual([]);
    expect(harness.shouldShowFrozenPreToolText.value).toBe(false);
  });
});
