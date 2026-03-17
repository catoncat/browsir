import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useChatStore, type RuntimeStateView } from "../chat-store";
import { sendMessage } from "../send-message";

vi.mock("../send-message", () => ({
  sendMessage: vi.fn(),
}));

function buildRuntimeState(
  overrides: Partial<RuntimeStateView> = {},
): RuntimeStateView {
  return {
    paused: false,
    stopped: false,
    retry: {
      active: false,
      attempt: 0,
      maxAttempts: 0,
      delayMs: 0,
    },
    ...overrides,
  };
}

describe("chat-store", () => {
  const sendMessageMock = vi.mocked(sendMessage);

  beforeEach(() => {
    setActivePinia(createPinia());
    sendMessageMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not auto-select the first historical session during refresh", async () => {
    const store = useChatStore();
    store.messages = [
      {
        role: "assistant",
        content: "旧消息",
        entryId: "entry-old",
      },
    ];
    store.runtime = buildRuntimeState({ running: true });

    sendMessageMock.mockResolvedValueOnce({
      sessions: [
        {
          id: "session-old",
          title: "旧失败会话",
          createdAt: "2026-03-17T13:40:00.000Z",
          updatedAt: "2026-03-17T13:40:10.000Z",
        },
      ],
    });

    await store.refreshSessions();

    expect(store.sessions).toHaveLength(1);
    expect(store.activeSessionId).toBe("");
    expect(store.messages).toEqual([]);
    expect(store.runtime).toBeNull();
  });

  it("starts a new session for the first prompt when no active session is selected", async () => {
    const store = useChatStore();

    sendMessageMock
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "session-old",
            title: "旧失败会话",
            createdAt: "2026-03-17T13:40:00.000Z",
            updatedAt: "2026-03-17T13:40:10.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionId: "session-new",
        runtime: buildRuntimeState({ running: true }),
      })
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "session-new",
            title: "新对话",
            createdAt: "2026-03-17T13:50:00.000Z",
            updatedAt: "2026-03-17T13:50:00.000Z",
          },
          {
            id: "session-old",
            title: "旧失败会话",
            createdAt: "2026-03-17T13:40:00.000Z",
            updatedAt: "2026-03-17T13:40:10.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        conversationView: {
          messages: [
            {
              role: "user",
              content: "你好",
              entryId: "entry-user-1",
            },
          ],
          lastStatus: buildRuntimeState({ running: true }),
        },
      });

    await store.refreshSessions();
    await store.sendPrompt("你好");

    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "brain.run.start", {
      sessionId: undefined,
      prompt: "你好",
      tabIds: [],
      streamingBehavior: undefined,
    });
    expect(store.activeSessionId).toBe("session-new");
  });
});
