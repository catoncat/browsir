import { ref, type ComputedRef, type Ref } from "vue";
import { toRecord } from "../utils/tool-formatters";
import {
  createPanelUiPluginRuntime,
  type UiChatInputPayload,
  type UiChatInputRenderPayload,
  type UiExtensionDescriptor,
  type UiHeaderRenderPayload,
  type UiMessageListRenderPayload,
  type UiMessageRenderPayload,
  type UiQueueRenderPayload,
  type UiSessionListRenderPayload,
  type UiToolRenderPayload,
  type UiNoticePayload,
} from "../utils/ui-plugin-runtime";
import type {
  SessionListRenderSessionItem,
  DisplayMessage,
  QueuedPromptViewItem,
  RuntimeResponse,
} from "../types";

function nowIso(): string {
  return new Date().toISOString();
}

export interface UiRenderPipelineDeps {
  sessions: Ref<any[]>;
  activeSessionId: Ref<string>;
  loading: Ref<boolean>;
  getListOpen: () => boolean;
  prompt: Ref<string>;
  creatingSession: Ref<boolean>;
  isStopping: ComputedRef<boolean>;
  isRunActive: ComputedRef<boolean>;
  isCompacting: ComputedRef<boolean>;
  activeSessionTitle: ComputedRef<string>;
  activeForkSourceSessionId: ComputedRef<string>;
  queuedPromptViewItems: ComputedRef<QueuedPromptViewItem[]>;
  runtimeQueueState: ComputedRef<{ steer: number; followUp: number; total: number }>;
  startRunPending: Ref<boolean>;
  baseConversationMessages: ComputedRef<DisplayMessage[]>;
  actionNotice: Ref<{ type: string; message: string } | null>;
}

export function useUiRenderPipeline(deps: UiRenderPipelineDeps) {
  const panelUiRuntime = createPanelUiPluginRuntime({
    defaultTimeoutMs: 150,
    getActiveSessionId: () => String(deps.activeSessionId.value || "").trim() || undefined,
  });

  const uiRenderEpoch = ref(0);
  const stableMessages = ref<DisplayMessage[]>([]);
  const sessionListRenderState = ref<{
    sessions: SessionListRenderSessionItem[];
    activeId: string;
  }>({
    sessions: [],
    activeId: "",
  });
  const headerRenderState = ref<{ title: string }>({ title: "新对话" });
  const queueRenderState = ref<{
    items: QueuedPromptViewItem[];
    state: { steer: number; followUp: number; total: number };
  }>({
    items: [],
    state: { steer: 0, followUp: 0, total: 0 },
  });
  const chatInputRenderState = ref<{ placeholder: string }>({
    placeholder: "/技能 @标签",
  });

  let panelNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  let stableMessagesBuildToken = 0;
  const reportedPanelUiPluginFailures = new Set<string>();

  // --- Notice ---

  function clearPanelNoticeTimer() {
    if (!panelNoticeTimer) return;
    clearTimeout(panelNoticeTimer);
    panelNoticeTimer = null;
  }

  function normalizeUiNoticePayload(input: unknown): UiNoticePayload | null {
    const row = toRecord(input);
    const message = String(row.message || "").trim();
    if (!message) return null;
    const rawType = String(row.type || "").trim().toLowerCase();
    const type = rawType === "error" ? "error" : "success";
    const durationRaw = Number(row.durationMs);
    const durationMs = Number.isFinite(durationRaw)
      ? Math.max(800, Math.min(15_000, Math.floor(durationRaw)))
      : undefined;
    return {
      type,
      message,
      source: String(row.source || "").trim() || undefined,
      sessionId: String(row.sessionId || "").trim() || undefined,
      durationMs,
      dedupeKey: String(row.dedupeKey || "").trim() || undefined,
      ts: String(row.ts || "").trim() || undefined,
    };
  }

  async function showActionNoticeWithPlugins(input: unknown) {
    const normalized = normalizeUiNoticePayload(input);
    if (!normalized) return;
    const hook = await panelUiRuntime.runHook("ui.notice.before_show", normalized);
    if (hook.blocked) return;
    const next = normalizeUiNoticePayload(hook.value);
    if (!next) return;
    deps.actionNotice.value = {
      type: next.type === "error" ? "error" : "success",
      message: next.message,
    };
    clearPanelNoticeTimer();
    const duration = Number(next.durationMs) || 2200;
    panelNoticeTimer = setTimeout(() => {
      deps.actionNotice.value = null;
      panelNoticeTimer = null;
    }, duration);
  }

  // --- Plugin lifecycle ---

  async function reportPanelUiPluginLoadFailures() {
    const failures = panelUiRuntime.listLoadFailures();
    let shouldNotify = false;
    for (const failure of failures) {
      const signature = `${failure.pluginId}:${failure.moduleUrl}:${failure.error}`;
      if (reportedPanelUiPluginFailures.has(signature)) continue;
      reportedPanelUiPluginFailures.add(signature);
      shouldNotify = true;
      console.error("[panel-ui-plugin] load failure", failure);
    }
    if (!shouldNotify) return;
    await showActionNoticeWithPlugins({
      type: "error",
      message: "插件界面加载失败，已自动停用",
      source: "panel.ui_plugin_runtime",
    });
  }

  function normalizeUiExtensionDescriptor(input: unknown): UiExtensionDescriptor | null {
    const row = toRecord(input);
    const pluginId = String(row.pluginId || "").trim();
    const moduleUrl = String(row.moduleUrl || "").trim();
    if (!pluginId || !moduleUrl) return null;
    return {
      pluginId,
      moduleUrl,
      exportName: String(row.exportName || "default").trim() || "default",
      enabled: row.enabled !== false,
      updatedAt: String(row.updatedAt || "").trim() || new Date().toISOString(),
      sessionId: String(row.sessionId || "").trim() || undefined,
    };
  }

  async function hydratePanelUiPlugins() {
    const response = (await chrome.runtime.sendMessage({
      type: "brain.plugin.ui_extension.list",
    })) as RuntimeResponse<{ uiExtensions?: unknown[] }>;
    if (!response?.ok) {
      throw new Error(String(response?.error || "brain.plugin.ui_extension.list failed"));
    }
    const list = Array.isArray(response.data?.uiExtensions) ? response.data?.uiExtensions : [];
    await panelUiRuntime.hydrate(list);
    await reportPanelUiPluginLoadFailures();
    bumpUiRenderEpoch();
  }

  async function applyUiExtensionLifecycleMessage(type: string, payload: unknown): Promise<boolean> {
    const descriptor = normalizeUiExtensionDescriptor(payload);
    if (!descriptor) return false;
    if (type === "brain.plugin.ui_extension.registered") {
      await panelUiRuntime.registerDescriptor(descriptor);
      await reportPanelUiPluginLoadFailures();
      bumpUiRenderEpoch();
      return true;
    }
    if (type === "brain.plugin.ui_extension.enabled") {
      await panelUiRuntime.registerDescriptor({ ...descriptor, enabled: true });
      await panelUiRuntime.enable(descriptor.pluginId);
      await reportPanelUiPluginLoadFailures();
      bumpUiRenderEpoch();
      return true;
    }
    if (type === "brain.plugin.ui_extension.disabled") {
      await panelUiRuntime.registerDescriptor({ ...descriptor, enabled: false });
      await panelUiRuntime.disable(descriptor.pluginId);
      bumpUiRenderEpoch();
      return true;
    }
    if (type === "brain.plugin.ui_extension.unregistered") {
      await panelUiRuntime.unregister(descriptor.pluginId);
      bumpUiRenderEpoch();
      return true;
    }
    return false;
  }

  // --- Send mode ---

  function normalizeSendMode(raw: unknown): "normal" | "steer" | "followUp" {
    const text = String(raw || "").trim();
    if (text === "steer" || text === "followUp") return text;
    return "normal";
  }

  function normalizeUiChatInputPayload(input: unknown): UiChatInputPayload {
    const row = toRecord(input);
    const tabIds = Array.isArray(row.tabIds)
      ? row.tabIds
          .map((item) => Number(item))
          .filter((value) => Number.isFinite(value))
          .map((value) => Math.floor(value))
      : [];
    const skillIds = Array.isArray(row.skillIds)
      ? row.skillIds.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
      : [];
    const contextRefs = Array.isArray(row.contextRefs)
      ? row.contextRefs
          .filter((item) => item && typeof item === "object")
          .map((item) => ({ ...(item as Record<string, unknown>) }))
      : [];
    return {
      text: String(row.text || ""),
      tabIds,
      skillIds,
      contextRefs,
      mode: normalizeSendMode(row.mode),
      sessionId: String(row.sessionId || "").trim() || undefined,
    };
  }

  // --- Payload builders & normalizers ---

  function toUiSessionListRenderPayload(): UiSessionListRenderPayload {
    const rows = Array.isArray(deps.sessions.value) ? deps.sessions.value : [];
    return {
      sessions: rows
        .map((session) => ({
          id: String(session.id || "").trim(),
          title: String(session.title || "").trim() || "新对话",
          updatedAt: String(session.updatedAt || "").trim() || undefined,
          parentSessionId: String(session.parentSessionId || "").trim() || undefined,
          sourceLabel: String(session.sourceLabel || "").trim() || undefined,
          forkedFromSessionId: String(session.forkedFrom?.sessionId || "").trim() || undefined,
        }))
        .filter((item) => item.id),
      activeId: String(deps.activeSessionId.value || "").trim(),
      isOpen: deps.getListOpen(),
      loading: deps.loading.value,
    };
  }

  function normalizeUiSessionListRenderPayload(
    input: unknown,
    fallback: UiSessionListRenderPayload
  ): { sessions: SessionListRenderSessionItem[]; activeId: string } {
    const row = toRecord(input);
    const source = Array.isArray(row.sessions) ? row.sessions : fallback.sessions;
    const sessionsOut: SessionListRenderSessionItem[] = [];
    for (const item of source) {
      const session = toRecord(item);
      const id = String(session.id || "").trim();
      if (!id) continue;
      sessionsOut.push({
        id,
        title: String(session.title || "").trim() || "新对话",
        updatedAt: String(session.updatedAt || "").trim() || undefined,
        parentSessionId: String(session.parentSessionId || "").trim() || undefined,
        sourceLabel: String(session.sourceLabel || "").trim() || undefined,
        forkedFrom: String(session.forkedFromSessionId || "").trim()
          ? { sessionId: String(session.forkedFromSessionId || "").trim() }
          : null,
      });
    }
    return {
      sessions: sessionsOut,
      activeId: String((row.activeId ?? fallback.activeId) || "").trim(),
    };
  }

  function toUiHeaderRenderPayload(): UiHeaderRenderPayload {
    return {
      sessionId: String(deps.activeSessionId.value || "").trim() || undefined,
      title: String(deps.activeSessionTitle.value || "").trim() || "新对话",
      isRunning: deps.isRunActive.value,
      isCompacting: deps.isCompacting.value,
      forkedFromSessionId: String(deps.activeForkSourceSessionId.value || "").trim() || undefined,
    };
  }

  function normalizeUiHeaderRenderPayload(
    input: unknown,
    fallback: UiHeaderRenderPayload
  ): { title: string } {
    const row = toRecord(input);
    const title = String((row.title ?? fallback.title) || "").trim() || "新对话";
    return { title };
  }

  function toUiQueueRenderPayload(): UiQueueRenderPayload {
    return {
      sessionId: String(deps.activeSessionId.value || "").trim() || undefined,
      items: deps.queuedPromptViewItems.value
        .map((item) => ({
          id: String(item.id || "").trim(),
          behavior: item.behavior === "steer" ? ("steer" as const) : ("followUp" as const),
          text: String(item.text || ""),
        }))
        .filter((item) => item.id && item.text.trim().length > 0),
      state: {
        steer: Number(deps.runtimeQueueState.value.steer || 0),
        followUp: Number(deps.runtimeQueueState.value.followUp || 0),
        total: Number(deps.runtimeQueueState.value.total || 0),
      },
    };
  }

  function normalizeUiQueueRenderPayload(
    input: unknown,
    fallback: UiQueueRenderPayload
  ): {
    items: QueuedPromptViewItem[];
    state: { steer: number; followUp: number; total: number };
  } {
    const row = toRecord(input);
    const sourceItems = Array.isArray(row.items) ? row.items : fallback.items;
    const items: QueuedPromptViewItem[] = [];
    for (const item of sourceItems) {
      const queueItem = toRecord(item);
      const id = String(queueItem.id || "").trim();
      const text = String(queueItem.text || "");
      if (!id || !text.trim()) continue;
      items.push({
        id,
        behavior: String(queueItem.behavior || "") === "steer" ? "steer" : "followUp",
        text,
        timestamp: nowIso(),
      });
    }
    const state = toRecord(row.state);
    const steer = Number(state.steer);
    const followUp = Number(state.followUp);
    const total = Number(state.total);
    return {
      items,
      state: {
        steer: Number.isFinite(steer) ? Math.max(0, Math.floor(steer)) : fallback.state.steer,
        followUp: Number.isFinite(followUp) ? Math.max(0, Math.floor(followUp)) : fallback.state.followUp,
        total: Number.isFinite(total) ? Math.max(0, Math.floor(total)) : fallback.state.total,
      },
    };
  }

  function toUiChatInputRenderPayload(): UiChatInputRenderPayload {
    return {
      sessionId: String(deps.activeSessionId.value || "").trim() || undefined,
      text: String(deps.prompt.value || ""),
      placeholder: String(chatInputRenderState.value.placeholder || "").trim() || "/技能 @标签",
      disabled: Boolean(deps.loading.value || deps.creatingSession.value || deps.isStopping.value),
      isRunning: deps.isRunActive.value,
      isCompacting: deps.isCompacting.value,
      isStartingRun: Boolean(deps.startRunPending.value && !deps.isRunActive.value),
    };
  }

  function normalizeUiChatInputRenderPayload(
    input: unknown,
    fallback: UiChatInputRenderPayload
  ): { placeholder: string } {
    const row = toRecord(input);
    const placeholder = String((row.placeholder ?? fallback.placeholder) || "").trim() || "/技能 @标签";
    return { placeholder };
  }

  function toUiMessageListRenderPayload(items: DisplayMessage[]): UiMessageListRenderPayload {
    return {
      sessionId: String(deps.activeSessionId.value || "").trim() || undefined,
      isRunning: deps.isRunActive.value,
      messages: items.map((item) => toUiMessageRenderPayload(item)),
    };
  }

  function normalizeUiMessageListRenderPayload(
    input: unknown,
    fallback: DisplayMessage[]
  ): DisplayMessage[] {
    const fallbackByEntryId = new Map<string, DisplayMessage>();
    for (const item of fallback) {
      const id = String(item.entryId || "").trim();
      if (id) fallbackByEntryId.set(id, item);
    }

    const row = toRecord(input);
    const source = Array.isArray(row.messages)
      ? row.messages
      : fallback.map((item) => toUiMessageRenderPayload(item));
    const out: DisplayMessage[] = [];
    for (const item of source) {
      const raw = toRecord(item);
      const entryId = String(raw.entryId || "").trim();
      const fallbackItem = fallbackByEntryId.get(entryId) || {
        role: String(raw.role || "assistant"),
        content: "",
        entryId: entryId || `ui-${Math.random().toString(36).slice(2, 8)}`,
        toolName: "",
        toolCallId: "",
      };
      const normalized = normalizeUiMessageRenderPayload(raw, fallbackItem);
      if (!normalized) continue;
      out.push(normalized);
    }
    return out;
  }

  function toUiMessageRenderPayload(input: DisplayMessage): UiMessageRenderPayload {
    return {
      role: String(input.role || "").trim(),
      content: String(input.content || ""),
      entryId: String(input.entryId || "").trim(),
      toolName: String(input.toolName || "").trim() || undefined,
      toolCallId: String(input.toolCallId || "").trim() || undefined,
    };
  }

  function normalizeUiMessageRenderPayload(
    input: unknown,
    fallback: DisplayMessage
  ): DisplayMessage | null {
    const row = toRecord(input);
    const entryId = String(row.entryId ?? fallback.entryId ?? "").trim();
    if (!entryId) return null;
    const role =
      String(row.role ?? fallback.role ?? "").trim() || String(fallback.role || "").trim();
    return {
      role,
      content: String(row.content ?? fallback.content ?? ""),
      entryId,
      toolName: String(row.toolName ?? fallback.toolName ?? "").trim() || "",
      toolCallId: String(row.toolCallId ?? fallback.toolCallId ?? "").trim() || "",
    };
  }

  function toUiToolRenderPayload(input: DisplayMessage): {
    toolName: string;
    toolCallId: string;
    content: string;
  } {
    return {
      toolName: String(input.toolName || "").trim(),
      toolCallId: String(input.toolCallId || "").trim(),
      content: String(input.content || ""),
    };
  }

  function normalizeUiToolRenderPayload(
    input: unknown,
    fallback: DisplayMessage
  ): { toolName: string; toolCallId: string; content: string } {
    const row = toRecord(input);
    return {
      toolName: String(row.toolName ?? fallback.toolName ?? "").trim() || "",
      toolCallId: String(row.toolCallId ?? fallback.toolCallId ?? "").trim() || "",
      content: String(row.content ?? fallback.content ?? ""),
    };
  }

  // --- Epoch bump ---

  function bumpUiRenderEpoch() {
    uiRenderEpoch.value += 1;
  }

  // --- Render hook application ---

  async function applyUiRenderHooksToMessage(input: DisplayMessage): Promise<DisplayMessage | null> {
    const base = normalizeUiMessageRenderPayload(input, input);
    if (!base) return null;

    const messageHook = await panelUiRuntime.runHook(
      "ui.message.before_render",
      toUiMessageRenderPayload(base)
    );
    if (messageHook.blocked) return null;
    let current = normalizeUiMessageRenderPayload(messageHook.value, base);
    if (!current) return null;

    if (current.role !== "tool") {
      return current;
    }

    const toolCallHook = await panelUiRuntime.runHook(
      "ui.tool.call.before_render",
      toUiToolRenderPayload(current)
    );
    if (toolCallHook.blocked) return null;
    const toolCallPatched = normalizeUiToolRenderPayload(toolCallHook.value, current);
    current = { ...current, ...toolCallPatched };

    const toolResultHook = await panelUiRuntime.runHook(
      "ui.tool.result.before_render",
      toUiToolRenderPayload(current)
    );
    if (toolResultHook.blocked) return null;
    const toolResultPatched = normalizeUiToolRenderPayload(toolResultHook.value, current);
    current = { ...current, ...toolResultPatched };
    return current;
  }

  // --- Rebuild functions ---

  async function rebuildStableMessages() {
    const token = ++stableMessagesBuildToken;
    const source = deps.baseConversationMessages.value;
    const next: DisplayMessage[] = [];
    for (const item of source) {
      const rendered = await applyUiRenderHooksToMessage(item);
      if (!rendered) continue;
      next.push(rendered);
    }
    const listHook = await panelUiRuntime.runHook(
      "ui.message.list.before_render",
      toUiMessageListRenderPayload(next)
    );
    if (listHook.blocked) {
      if (token !== stableMessagesBuildToken) return;
      stableMessages.value = [];
      return;
    }
    const listPatched = normalizeUiMessageListRenderPayload(listHook.value, next);
    if (token !== stableMessagesBuildToken) return;
    stableMessages.value = listPatched;
  }

  async function rebuildSessionListRenderState() {
    const fallback = toUiSessionListRenderPayload();
    const hook = await panelUiRuntime.runHook("ui.session.list.before_render", fallback);
    if (hook.blocked) {
      sessionListRenderState.value = {
        sessions: fallback.sessions.map((item) => ({
          id: item.id,
          title: item.title,
          updatedAt: item.updatedAt,
          parentSessionId: item.parentSessionId,
          forkedFrom: item.forkedFromSessionId ? { sessionId: item.forkedFromSessionId } : null,
        })),
        activeId: fallback.activeId,
      };
      return;
    }
    sessionListRenderState.value = normalizeUiSessionListRenderPayload(hook.value, fallback);
  }

  async function rebuildHeaderRenderState() {
    const fallback = toUiHeaderRenderPayload();
    const hook = await panelUiRuntime.runHook("ui.header.before_render", fallback);
    if (hook.blocked) {
      headerRenderState.value = normalizeUiHeaderRenderPayload(fallback, fallback);
      return;
    }
    headerRenderState.value = normalizeUiHeaderRenderPayload(hook.value, fallback);
  }

  async function rebuildQueueRenderState() {
    const fallback = toUiQueueRenderPayload();
    const hook = await panelUiRuntime.runHook("ui.queue.before_render", fallback);
    if (hook.blocked) {
      queueRenderState.value = normalizeUiQueueRenderPayload(fallback, fallback);
      return;
    }
    queueRenderState.value = normalizeUiQueueRenderPayload(hook.value, fallback);
  }

  async function rebuildChatInputRenderState() {
    const fallback = toUiChatInputRenderPayload();
    const hook = await panelUiRuntime.runHook("ui.chat_input.before_render", fallback);
    if (hook.blocked) {
      chatInputRenderState.value = normalizeUiChatInputRenderPayload(fallback, fallback);
      return;
    }
    chatInputRenderState.value = normalizeUiChatInputRenderPayload(hook.value, fallback);
  }

  // --- Cleanup ---

  function cleanup() {
    stableMessagesBuildToken += 1;
    clearPanelNoticeTimer();
    void panelUiRuntime.dispose();
  }

  return {
    panelUiRuntime,
    uiRenderEpoch,
    stableMessages,
    sessionListRenderState,
    headerRenderState,
    queueRenderState,
    chatInputRenderState,
    hydratePanelUiPlugins,
    applyUiExtensionLifecycleMessage,
    showActionNoticeWithPlugins,
    bumpUiRenderEpoch,
    normalizeSendMode,
    normalizeUiChatInputPayload,
    rebuildStableMessages,
    rebuildSessionListRenderState,
    rebuildHeaderRenderState,
    rebuildQueueRenderState,
    rebuildChatInputRenderState,
    cleanup,
  };
}
