import { ref, type Ref, type ComputedRef } from "vue";

type JsonRecord = Record<string, unknown>;

interface SendPayload {
  text: string;
  tabIds: number[];
  skillIds: string[];
  contextRefs: Array<JsonRecord>;
  mode: "normal" | "steer" | "followUp";
}

interface NormalizedSendInput {
  text: string;
  tabIds: number[];
  skillIds: string[];
  contextRefs: Array<JsonRecord>;
  mode: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface HookResult {
  blocked?: boolean;
  reason?: string;
  value: NormalizedSendInput;
}

export interface UseChatSendActionOptions {
  activeSessionId: Ref<string | undefined>;
  sessions: Ref<Array<{ id: string; [key: string]: unknown }>>;
  prompt: Ref<string>;
  creatingSession: Ref<boolean>;
  startRunPending: Ref<boolean>;
  isRunActive: ComputedRef<boolean>;
  activeForkSourceSessionId: ComputedRef<string>;
  queuedPromotingIds: Ref<Set<string>>;
  runSafely: (task: () => Promise<void>, fallback: string) => Promise<void>;
  setErrorMessage: (err: unknown, fallback: string) => void;
  showActionNoticeWithPlugins: (notice: {
    type: string;
    message: string;
    source: string;
  }) => Promise<void>;
  normalizeUiChatInputPayload: (input: JsonRecord) => NormalizedSendInput;
  panelUiRunHook: (hook: string, payload: JsonRecord) => Promise<HookResult>;
  chatStoreCreateSession: () => Promise<void>;
  chatStoreRefreshSessions: () => Promise<void>;
  chatStoreRefreshSessionTitle: (id: string) => Promise<void>;
  chatStoreRunAction: (action: string) => Promise<void>;
  chatStorePromoteQueuedPromptToSteer: (id: string) => Promise<void>;
  chatStoreSendPrompt: (
    text: string,
    options: {
      newSession: boolean;
      tabIds: number[];
      skillIds: string[];
      contextRefs: Array<JsonRecord>;
      streamingBehavior?: string;
    },
  ) => Promise<void>;
  playForkSceneSwitch: (sessionId: string) => Promise<void>;
  emitUpdateListOpen: (open: boolean) => void;
}

export function useChatSendAction(options: UseChatSendActionOptions) {
  const {
    activeSessionId,
    sessions,
    prompt,
    creatingSession,
    startRunPending,
    isRunActive,
    activeForkSourceSessionId,
    queuedPromotingIds,
    runSafely,
    setErrorMessage,
    showActionNoticeWithPlugins,
    normalizeUiChatInputPayload,
    panelUiRunHook,
    chatStoreCreateSession,
    chatStoreRefreshSessions,
    chatStoreRefreshSessionTitle,
    chatStoreRunAction,
    chatStorePromoteQueuedPromptToSteer,
    chatStoreSendPrompt,
    playForkSceneSwitch,
    emitUpdateListOpen,
  } = options;

  let createSessionTask: Promise<void> | null = null;

  async function handleCreateSession() {
    if (createSessionTask) {
      await createSessionTask;
      return;
    }
    creatingSession.value = true;
    createSessionTask = runSafely(async () => {
      await chatStoreCreateSession();
      emitUpdateListOpen(false);
    }, "新建会话失败").finally(() => {
      creatingSession.value = false;
      createSessionTask = null;
    });
    await createSessionTask;
  }

  async function handleJumpToForkSourceSession() {
    const sourceId = activeForkSourceSessionId.value;
    if (!sourceId) return;
    await runSafely(async () => {
      if (!sessions.value.some((item) => item.id === sourceId)) {
        await chatStoreRefreshSessions();
      }
      await playForkSceneSwitch(sourceId);
    }, "跳转分叉来源失败");
  }

  async function handleRefreshSession(id: string) {
    await runSafely(
      () => chatStoreRefreshSessionTitle(id),
      "刷新标题失败",
    );
  }

  async function handleStopRun() {
    await runSafely(
      () => chatStoreRunAction("brain.run.stop"),
      "停止任务失败",
    );
  }

  function isQueuedPromptPromoting(id: string): boolean {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return false;
    return queuedPromotingIds.value.has(normalizedId);
  }

  function setQueuedPromptPromoting(id: string, active: boolean) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return;
    const next = new Set(queuedPromotingIds.value);
    if (active) next.add(normalizedId);
    else next.delete(normalizedId);
    queuedPromotingIds.value = next;
  }

  async function handlePromoteQueuedPromptToSteer(queuedPromptId: string) {
    const id = String(queuedPromptId || "").trim();
    if (!id) return;
    if (!activeSessionId.value) return;
    if (isQueuedPromptPromoting(id)) return;
    setQueuedPromptPromoting(id, true);
    try {
      await chatStorePromoteQueuedPromptToSteer(id);
    } catch (err) {
      setErrorMessage(err, "直接插入失败");
    } finally {
      setQueuedPromptPromoting(id, false);
    }
  }

  async function handleSend(payload: SendPayload) {
    if (createSessionTask) {
      await createSessionTask;
    }
    if (startRunPending.value && !isRunActive.value) return;
    const currentSessionId = String(activeSessionId.value || "").trim();
    const beforeSend = await panelUiRunHook(
      "ui.chat_input.before_send",
      normalizeUiChatInputPayload({
        ...payload,
        sessionId: currentSessionId || undefined,
      }),
    );
    if (beforeSend.blocked) {
      await showActionNoticeWithPlugins({
        type: "error",
        message:
          String(beforeSend.reason || "").trim() || "发送已被插件阻止",
        source: "ui.plugin",
      });
      return;
    }

    const sendInput = normalizeUiChatInputPayload(beforeSend.value);
    const text = String(sendInput.text || "");
    if (
      !text.trim() &&
      sendInput.skillIds.length === 0 &&
      sendInput.contextRefs.length === 0
    )
      return;
    const isNew = !currentSessionId;
    const shouldExpectRunStart = !isRunActive.value;

    try {
      if (shouldExpectRunStart) {
        startRunPending.value = true;
      }
      await chatStoreSendPrompt(text, {
        newSession: isNew,
        tabIds: sendInput.tabIds,
        skillIds: sendInput.skillIds,
        contextRefs: sendInput.contextRefs,
        streamingBehavior:
          sendInput.mode === "normal" ? undefined : sendInput.mode,
      });
      const sessionIdAfterSend =
        String(activeSessionId.value || "").trim() || sendInput.sessionId;
      void panelUiRunHook("ui.chat_input.after_send", {
        ...sendInput,
        sessionId: sessionIdAfterSend || undefined,
      });
      prompt.value = "";
    } catch (err) {
      startRunPending.value = false;
      setErrorMessage(err, "发送失败");
    } finally {
      if (shouldExpectRunStart || !isRunActive.value) {
        startRunPending.value = false;
      }
    }
  }

  return {
    handleCreateSession,
    handleJumpToForkSourceSession,
    handleRefreshSession,
    handleStopRun,
    handlePromoteQueuedPromptToSteer,
    handleSend,
  };
}
