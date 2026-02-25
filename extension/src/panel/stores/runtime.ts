import { defineStore } from "pinia";
import { ref } from "vue";

interface RuntimeResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface ConversationMessage {
  role: string;
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
}

interface SessionForkSource {
  sessionId: string;
  leafId: string;
  sourceEntryId: string;
  reason: string;
}

interface SessionIndexEntry {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  forkedFrom?: SessionForkSource | null;
}

interface RuntimeStateView {
  running?: boolean;
  compacting?: boolean;
  paused: boolean;
  stopped: boolean;
  lifecycle?: "idle" | "running" | "stopping";
  queue?: {
    dequeueMode?: "one-at-a-time" | "all";
    steer?: number;
    followUp?: number;
    total?: number;
    items?: Array<{
      id?: string;
      behavior?: "steer" | "followUp";
      text?: string;
      timestamp?: string;
    }>;
  };
  retry: {
    active: boolean;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
  };
}

function normalizeRuntimeState(raw: RuntimeStateView | null | undefined): RuntimeStateView | null {
  if (!raw) return null;
  const running = raw.running === true;
  const stopped = raw.stopped === true;
  const lifecycle: "idle" | "running" | "stopping" = running
    ? (stopped ? "stopping" : "running")
    : "idle";
  return {
    ...raw,
    lifecycle
  };
}

interface PanelConfig {
  bridgeUrl: string;
  bridgeToken: string;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  maxSteps: number;
  autoTitleInterval: number;
  bridgeInvokeTimeoutMs: number;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
  devAutoReload: boolean;
  devReloadIntervalMs: number;
}

interface RuntimeHealth {
  bridgeUrl: string;
  llmApiBase: string;
  llmModel: string;
  hasLlmApiKey: boolean;
}

interface EditUserRerunResult {
  sessionId: string;
  runtime: RuntimeStateView;
  mode: "retry" | "fork";
  sourceSessionId: string;
  sourceEntryId: string;
  activeSourceEntryId: string;
}

interface EditUserRerunOptions {
  setActive?: boolean;
}

interface LoadConversationOptions {
  setActive?: boolean;
}

interface RegenerateFromAssistantOptions {
  mode?: "fork" | "retry";
  setActive?: boolean;
}

interface RegenerateFromAssistantResult {
  sessionId: string;
  mode: "fork" | "retry";
  sourceEntryId?: string;
}

async function sendMessage<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = (await chrome.runtime.sendMessage({ type, ...payload })) as RuntimeResponse<T>;
  if (!response?.ok) {
    throw new Error(response?.error || `${type} failed`);
  }
  return response.data as T;
}

function normalizeConfig(raw: Record<string, unknown> | null | undefined): PanelConfig {
  return {
    bridgeUrl: String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws"),
    bridgeToken: String(raw?.bridgeToken || ""),
    llmApiBase: String(raw?.llmApiBase || "https://ai.chen.rs/v1"),
    llmApiKey: String(raw?.llmApiKey || ""),
    llmModel: String(raw?.llmModel || "gpt-5.3-codex"),
    maxSteps: Number.isFinite(Number(raw?.maxSteps)) ? Number(raw?.maxSteps) : 100,
    autoTitleInterval: Number.isFinite(Number(raw?.autoTitleInterval)) ? Number(raw?.autoTitleInterval) : 10,
    bridgeInvokeTimeoutMs: Number.isFinite(Number(raw?.bridgeInvokeTimeoutMs)) ? Number(raw?.bridgeInvokeTimeoutMs) : 120000,
    llmTimeoutMs: Number.isFinite(Number(raw?.llmTimeoutMs)) ? Number(raw?.llmTimeoutMs) : 120000,
    llmRetryMaxAttempts: Number.isFinite(Number(raw?.llmRetryMaxAttempts)) ? Number(raw?.llmRetryMaxAttempts) : 2,
    llmMaxRetryDelayMs: Number.isFinite(Number(raw?.llmMaxRetryDelayMs)) ? Number(raw?.llmMaxRetryDelayMs) : 60000,
    devAutoReload: raw?.devAutoReload !== false,
    devReloadIntervalMs: Number.isFinite(Number(raw?.devReloadIntervalMs)) ? Number(raw?.devReloadIntervalMs) : 1500
  };
}

function normalizeHealth(raw: Record<string, unknown> | null | undefined): RuntimeHealth {
  return {
    bridgeUrl: String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws"),
    llmApiBase: String(raw?.llmApiBase || ""),
    llmModel: String(raw?.llmModel || "gpt-5.3-codex"),
    hasLlmApiKey: Boolean(raw?.hasLlmApiKey)
  };
}

export const useRuntimeStore = defineStore("runtime", () => {
  const loading = ref(false);
  const savingConfig = ref(false);
  const isRegeneratingTitle = ref(false);
  const error = ref("");
  const sessions = ref<SessionIndexEntry[]>([]);
  const activeSessionId = ref("");
  const messages = ref<ConversationMessage[]>([]);
  const runtime = ref<RuntimeStateView | null>(null);
  const conversationRequestSeq = ref(0);
  const health = ref<RuntimeHealth>(
    normalizeHealth({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      llmModel: "gpt-5.3-codex",
      hasLlmApiKey: false
    })
  );
  const config = ref<PanelConfig>(
    normalizeConfig({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      llmApiBase: "https://ai.chen.rs/v1",
      llmModel: "gpt-5.3-codex",
      autoTitleInterval: 10,
      bridgeInvokeTimeoutMs: 120000,
      llmTimeoutMs: 120000,
      llmRetryMaxAttempts: 2,
      llmMaxRetryDelayMs: 60000
    })
  );

  async function refreshSessions() {
    const index = await sendMessage<{ sessions: SessionIndexEntry[] }>("brain.session.list");
    sessions.value = Array.isArray(index.sessions) ? index.sessions : [];
    const activeExists = sessions.value.some((item) => item.id === activeSessionId.value);
    if (!activeExists) {
      activeSessionId.value = sessions.value[0]?.id || "";
    }
  }

  async function loadConversation(sessionId: string, options: LoadConversationOptions = {}) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return;

    const shouldSetActive = options.setActive === true;
    const previousActiveSessionId = activeSessionId.value;
    if (shouldSetActive) {
      activeSessionId.value = normalizedSessionId;
    }

    const requestSeq = ++conversationRequestSeq.value;

    try {
      const view = await sendMessage<{ conversationView: { messages: ConversationMessage[]; lastStatus: RuntimeStateView } }>(
        "brain.session.view",
        { sessionId: normalizedSessionId }
      );

      if (requestSeq !== conversationRequestSeq.value) {
        return;
      }
      if (activeSessionId.value !== normalizedSessionId) {
        return;
      }

      messages.value = view.conversationView?.messages ?? [];
      runtime.value = normalizeRuntimeState(view.conversationView?.lastStatus ?? null);
    } catch (err) {
      if (requestSeq === conversationRequestSeq.value && shouldSetActive) {
        activeSessionId.value = previousActiveSessionId;
      }
      throw err;
    }
  }

  async function createSession() {
    const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.start", {
      autoRun: false
    });
    runtime.value = normalizeRuntimeState(result.runtime);
    activeSessionId.value = result.sessionId;
    await refreshSessions();
    await loadConversation(result.sessionId, { setActive: true });
  }

  async function sendPrompt(
    prompt: string,
    options: { newSession?: boolean; tabIds?: number[]; streamingBehavior?: "steer" | "followUp" } = {}
  ) {
    const text = prompt.trim();
    if (!text) return;
    const useCurrentSession = !options.newSession && !!activeSessionId.value;
    const tabIds = Array.isArray(options.tabIds)
      ? options.tabIds.filter((id) => Number.isInteger(id)).map((id) => Number(id))
      : [];
    const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.start", {
      sessionId: useCurrentSession ? activeSessionId.value : undefined,
      prompt: text,
      tabIds,
      streamingBehavior: options.streamingBehavior
    });
    runtime.value = normalizeRuntimeState(result.runtime);
    activeSessionId.value = result.sessionId;
    await refreshSessions();
    await loadConversation(result.sessionId, { setActive: true });
  }

  function findAssistantMessageIndex(entryId: string) {
    return messages.value.findIndex((msg) => msg.entryId === entryId && msg.role === "assistant");
  }

  function findLatestAssistantEntryId() {
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const candidate = messages.value[i];
      if (candidate?.role !== "assistant") continue;
      const entryId = String(candidate.entryId || "").trim();
      const content = String(candidate.content || "").trim();
      if (entryId && content) return entryId;
    }
    return "";
  }

  function findPreviousUserEntryId(targetIndex: number) {
    for (let i = targetIndex - 1; i >= 0; i -= 1) {
      const candidate = messages.value[i];
      if (candidate?.role !== "user") continue;
      if (!String(candidate.content || "").trim()) continue;
      if (!String(candidate.entryId || "").trim()) continue;
      return String(candidate.entryId);
    }
    return "";
  }

  async function forkFromAssistantEntry(entryId: string, options: { autoRun?: boolean; setActive?: boolean } = {}) {
    if (!activeSessionId.value) {
      throw new Error("无活跃会话，无法分叉");
    }
    const currentSessionId = activeSessionId.value;
    const targetIndex = findAssistantMessageIndex(entryId);
    if (targetIndex < 0) {
      throw new Error("未找到可分叉的 assistant 消息");
    }
    const previousUserEntryId = findPreviousUserEntryId(targetIndex);
    if (!previousUserEntryId) {
      throw new Error("未找到前序 user 消息，无法分叉");
    }
    const forked = await sendMessage<{ sessionId: string; leafId?: string | null }>("brain.session.fork", {
      sessionId: currentSessionId,
      leafId: entryId,
      sourceEntryId: entryId,
      reason: "branch_from_assistant"
    });
    const forkedSessionId = String(forked.sessionId || "").trim();
    if (!forkedSessionId) {
      throw new Error("创建分叉会话失败");
    }
    const forkedSourceEntryId = String(forked.leafId || "").trim();

    if (options.autoRun === true) {
      if (!forkedSourceEntryId) {
        throw new Error("分叉后未找到可重生成的 sourceEntry");
      }
      const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.regenerate", {
        sessionId: forkedSessionId,
        sourceEntryId: forkedSourceEntryId,
        requireSourceIsLeaf: true,
        rebaseLeafToPreviousUser: true
      });
      runtime.value = normalizeRuntimeState(result.runtime);
    }

    await refreshSessions();
    if (options.setActive === false) {
      // 由上层决定何时切会话（例如播放 fork 场景动画）。
    } else {
      await loadConversation(forkedSessionId, { setActive: true });
    }
    return {
      sessionId: forkedSessionId,
      sourceEntryId: forkedSourceEntryId || entryId,
      mode: "fork" as const
    };
  }

  async function retryLastAssistantEntry(entryId: string, options: { setActive?: boolean } = {}) {
    if (!activeSessionId.value) {
      throw new Error("无活跃会话，无法重试");
    }
    const targetIndex = findAssistantMessageIndex(entryId);
    if (targetIndex < 0) {
      throw new Error("未找到可重试的 assistant 消息");
    }
    const previousUserEntryId = findPreviousUserEntryId(targetIndex);
    if (!previousUserEntryId) {
      throw new Error("未找到前序 user 消息，无法重试");
    }
    const latestAssistantEntryId = findLatestAssistantEntryId();
    if (!latestAssistantEntryId || latestAssistantEntryId !== entryId) {
      throw new Error("仅最后一条 assistant 支持重新回答；历史消息请使用分叉");
    }

    const currentSessionId = activeSessionId.value;
    const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.regenerate", {
      sessionId: currentSessionId,
      sourceEntryId: entryId,
      requireSourceIsLeaf: true,
      rebaseLeafToPreviousUser: true
    });
    runtime.value = normalizeRuntimeState(result.runtime);
    await refreshSessions();
    await loadConversation(currentSessionId, { setActive: options.setActive === true });
    return {
      sessionId: currentSessionId,
      mode: "retry" as const
    };
  }

  async function regenerateFromAssistantEntry(
    entryId: string,
    options: RegenerateFromAssistantOptions = {}
  ): Promise<RegenerateFromAssistantResult> {
    if (options.mode === "fork") {
      return forkFromAssistantEntry(entryId, { autoRun: true, setActive: options.setActive });
    }
    if (options.mode === "retry") {
      return retryLastAssistantEntry(entryId, { setActive: options.setActive });
    }
    const latestAssistantEntryId = findLatestAssistantEntryId();
    if (latestAssistantEntryId && latestAssistantEntryId === entryId) {
      return retryLastAssistantEntry(entryId, { setActive: options.setActive });
    }
    return forkFromAssistantEntry(entryId, { autoRun: true, setActive: options.setActive });
  }

  async function editUserMessageAndRerun(entryId: string, prompt: string, options: EditUserRerunOptions = {}) {
    if (!activeSessionId.value) {
      throw new Error("无活跃会话，无法编辑并重跑");
    }
    const sourceEntryId = String(entryId || "").trim();
    const editedText = String(prompt || "").trim();
    if (!sourceEntryId) {
      throw new Error("sourceEntryId 不能为空");
    }
    if (!editedText) {
      throw new Error("编辑内容不能为空");
    }

    const sourceSessionId = activeSessionId.value;
    const result = await sendMessage<EditUserRerunResult>("brain.run.edit_rerun", {
      sessionId: sourceSessionId,
      sourceEntryId,
      prompt: editedText
    });

    runtime.value = normalizeRuntimeState(result.runtime);
    await refreshSessions();
    if (options.setActive === false) {
      if (result.sessionId === activeSessionId.value) {
        await loadConversation(result.sessionId, { setActive: false });
      }
    } else {
      await loadConversation(result.sessionId, { setActive: true });
    }
    return {
      sessionId: result.sessionId,
      mode: result.mode,
      sourceSessionId: result.sourceSessionId,
      sourceEntryId: result.sourceEntryId,
      activeSourceEntryId: result.activeSourceEntryId
    };
  }

  async function runAction(type: "brain.run.pause" | "brain.run.resume" | "brain.run.stop") {
    if (!activeSessionId.value) return;
    runtime.value = normalizeRuntimeState(await sendMessage<RuntimeStateView>(type, { sessionId: activeSessionId.value }));
  }

  async function promoteQueuedPromptToSteer(queuedPromptId: string) {
    const sessionId = String(activeSessionId.value || "").trim();
    const id = String(queuedPromptId || "").trim();
    if (!sessionId) throw new Error("当前无活动会话");
    if (!id) throw new Error("queuedPromptId 不能为空");

    runtime.value = normalizeRuntimeState(await sendMessage<RuntimeStateView>("brain.run.queue.promote", {
      sessionId,
      queuedPromptId: id,
      targetBehavior: "steer"
    }));
  }

  async function refreshSessionTitle(sessionId = activeSessionId.value, force = true) {
    if (!sessionId) return;
    isRegeneratingTitle.value = true;
    try {
      await sendMessage("brain.session.title.refresh", { sessionId, force });
      await refreshSessions();
      if (activeSessionId.value === sessionId) {
        await loadConversation(sessionId, { setActive: false });
      }
    } finally {
      isRegeneratingTitle.value = false;
    }
  }

  async function updateSessionTitle(sessionId: string, title: string) {
    if (!sessionId) return;
    await sendMessage("brain.session.title.refresh", { sessionId, title });
    await refreshSessions();
    if (activeSessionId.value === sessionId) {
      await loadConversation(sessionId, { setActive: false });
    }
  }

  async function deleteSession(sessionId: string) {
    if (!sessionId) return;
    await sendMessage("brain.session.delete", { sessionId });
    await refreshSessions();
    if (!activeSessionId.value) {
      messages.value = [];
      runtime.value = null;
      return;
    }
    await loadConversation(activeSessionId.value, { setActive: false });
  }

  async function bootstrap() {
    loading.value = true;
    error.value = "";
    try {
      const cfg = await sendMessage<Record<string, unknown>>("config.get");
      config.value = normalizeConfig(cfg);
      await Promise.all([refreshHealth(), refreshSessions()]);
      if (activeSessionId.value) {
        await loadConversation(activeSessionId.value, { setActive: false });
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function refreshHealth() {
    const raw = await sendMessage<Record<string, unknown>>("brain.debug.config");
    health.value = normalizeHealth(raw);
  }

  async function saveConfig() {
    savingConfig.value = true;
    error.value = "";
    try {
      await sendMessage("config.save", {
        payload: {
          bridgeUrl: config.value.bridgeUrl.trim(),
          bridgeToken: config.value.bridgeToken,
          llmApiBase: config.value.llmApiBase.trim(),
          llmApiKey: config.value.llmApiKey,
          llmModel: config.value.llmModel.trim(),
          maxSteps: Math.max(1, Number(config.value.maxSteps || 100)),
          autoTitleInterval: Math.max(0, Number(config.value.autoTitleInterval ?? 10)),
          bridgeInvokeTimeoutMs: Math.max(1000, Number(config.value.bridgeInvokeTimeoutMs || 120000)),
          llmTimeoutMs: Math.max(1000, Number(config.value.llmTimeoutMs || 120000)),
          llmRetryMaxAttempts: Math.max(0, Math.min(6, Number(config.value.llmRetryMaxAttempts || 2))),
          llmMaxRetryDelayMs: Math.max(0, Number(config.value.llmMaxRetryDelayMs || 60000)),
          devAutoReload: config.value.devAutoReload,
          devReloadIntervalMs: Math.max(500, Number(config.value.devReloadIntervalMs || 1500))
        }
      });
      await sendMessage("bridge.connect");
      await refreshHealth();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      savingConfig.value = false;
    }
  }

  return {
    loading,
    savingConfig,
    isRegeneratingTitle,
    error,
    sessions,
    activeSessionId,
    messages,
    runtime,
    health,
    config,
    bootstrap,
    refreshSessions,
    refreshHealth,
    loadConversation,
    createSession,
    sendPrompt,
    forkFromAssistantEntry,
    retryLastAssistantEntry,
    regenerateFromAssistantEntry,
    editUserMessageAndRerun,
    runAction,
    promoteQueuedPromptToSteer,
    refreshSessionTitle,
    updateSessionTitle,
    deleteSession,
    saveConfig
  };
});
