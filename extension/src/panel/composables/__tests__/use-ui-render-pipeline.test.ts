// @vitest-environment happy-dom
import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";
import { useUiRenderPipeline } from "../use-ui-render-pipeline";
import type { DisplayMessage, QueuedPromptViewItem } from "../../types";

function createHarness(baseConversationMessages: DisplayMessage[]) {
  const sessions = ref<any[]>([]);
  const activeSessionId = ref("session-1");
  const loading = ref(false);
  const prompt = ref("");
  const creatingSession = ref(false);
  const startRunPending = ref(false);
  const actionNotice = ref<{ type: string; message: string } | null>(null);
  const queueItems = ref<QueuedPromptViewItem[]>([]);

  return useUiRenderPipeline({
    sessions,
    activeSessionId,
    loading,
    getListOpen: () => true,
    prompt,
    creatingSession,
    isStopping: computed(() => false),
    isRunActive: computed(() => false),
    isCompacting: computed(() => false),
    activeSessionTitle: computed(() => "测试会话"),
    activeForkSourceSessionId: computed(() => ""),
    queuedPromptViewItems: computed(() => queueItems.value),
    runtimeQueueState: computed(() => ({ steer: 0, followUp: 0, total: 0 })),
    startRunPending,
    baseConversationMessages: computed(() => baseConversationMessages),
    actionNotice,
  });
}

describe("useUiRenderPipeline", () => {
  it("preserves contentBlocks and toolResults through message list normalization", async () => {
    const assistantMessage: DisplayMessage = {
      role: "assistant",
      content: "原始内容",
      contentBlocks: [
        { type: "text", text: "先读取页面" },
        {
          type: "toolCall",
          id: "call_1",
          name: "search_elements",
          arguments: '{"query":"input"}',
        },
      ],
      toolResults: {
        call_1: '{"matches":1}',
      },
      entryId: "entry-assistant-1",
      toolName: "",
      toolCallId: "",
    };

    const pipeline = createHarness([assistantMessage]);
    const originalRunHook = (pipeline.panelUiRuntime as any).runHook;
    (pipeline.panelUiRuntime as any).runHook = async (hookName: string, payload: unknown) => {
      if (hookName === "ui.message.list.before_render") {
        return {
          blocked: false,
          value: {
            ...(payload as Record<string, unknown>),
            messages: [
              {
                role: "assistant",
                content: "插件改写后的文案",
                entryId: "entry-assistant-1",
              },
            ],
          },
        };
      }
      return originalRunHook.call(pipeline.panelUiRuntime, hookName, payload);
    };

    await pipeline.rebuildStableMessages();

    expect(pipeline.stableMessages.value).toHaveLength(1);
    expect(pipeline.stableMessages.value[0]).toMatchObject({
      role: "assistant",
      content: "插件改写后的文案",
      entryId: "entry-assistant-1",
      contentBlocks: assistantMessage.contentBlocks,
      toolResults: assistantMessage.toolResults,
    });

    pipeline.cleanup();
  });
});