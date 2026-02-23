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
}

interface SessionIndexEntry {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

interface RuntimeStateView {
  running?: boolean;
  paused: boolean;
  stopped: boolean;
  retry: {
    active: boolean;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
  };
}

interface PanelConfig {
  bridgeUrl: string;
  bridgeToken: string;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  devAutoReload: boolean;
  devReloadIntervalMs: number;
}

interface RuntimeHealth {
  bridgeUrl: string;
  llmApiBase: string;
  llmModel: string;
  hasLlmApiKey: boolean;
}

interface LoadConversationOptions {
  setActive?: boolean;
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
      llmModel: "gpt-5.3-codex"
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
      runtime.value = view.conversationView?.lastStatus ?? null;
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
    runtime.value = result.runtime;
    await refreshSessions();
    await loadConversation(result.sessionId, { setActive: true });
  }

  async function sendPrompt(prompt: string, options: { newSession?: boolean } = {}) {
    const text = prompt.trim();
    if (!text) return;
    const useCurrentSession = !options.newSession && !!activeSessionId.value;
    const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.start", {
      sessionId: useCurrentSession ? activeSessionId.value : undefined,
      prompt: text
    });
    runtime.value = result.runtime;
    await refreshSessions();
    await loadConversation(result.sessionId, { setActive: true });
  }

  async function regenerateFromAssistantEntry(entryId: string) {
    if (!activeSessionId.value) {
      throw new Error("无活跃会话，无法重答");
    }

    const targetIndex = messages.value.findIndex((msg) => msg.entryId === entryId && msg.role === "assistant");
    if (targetIndex < 0) {
      throw new Error("未找到可重答的 assistant 消息");
    }

    // Trigger a run without a prompt to regenerate from the existing context
    const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.start", {
      sessionId: activeSessionId.value
    });
    
    runtime.value = result.runtime;
    await refreshSessions();
    await loadConversation(activeSessionId.value, { setActive: false });
  }

  async function runAction(type: "brain.run.pause" | "brain.run.resume" | "brain.run.stop") {
    if (!activeSessionId.value) return;
    runtime.value = await sendMessage<RuntimeStateView>(type, { sessionId: activeSessionId.value });
  }

  async function refreshSessionTitle(sessionId = activeSessionId.value) {
    if (!sessionId) return;
    await sendMessage("brain.session.title.refresh", { sessionId });
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
    regenerateFromAssistantEntry,
    runAction,
    refreshSessionTitle,
    deleteSession,
    saveConfig
  };
});
