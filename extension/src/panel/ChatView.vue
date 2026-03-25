<script setup lang="ts">
import { onClickOutside } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, ref, watch } from "vue";
import { useRuntimeStore } from "./stores/runtime";
import { useChatStore } from "./stores/chat-store";
import { useConfigStore } from "./stores/config-store";
import { useMessageActions } from "./utils/message-actions";
import { useConversationExport } from "./composables/use-conversation-export";
import { useChatSendAction } from "./composables/use-chat-send-action";
import type {
  ViewMode,
  DisplayMessage,
  QueuedPromptViewItem,
} from "./types";
import { shouldAlwaysShowToolMessage } from "./utils/tool-formatters";
import type { RunTimelineItem } from "./utils/run-timeline";


import { useForkScene } from "./composables/use-fork-scene";
import { useMessageEditing } from "./composables/use-message-editing";
import { useUiRenderPipeline } from "./composables/use-ui-render-pipeline";
import { useLlmStreaming } from "./composables/use-llm-streaming";
import { useToolRunTracking } from "./composables/use-tool-run-tracking";
import { useRuntimeMessages } from "./composables/use-runtime-messages";
import { useChatScrollSync } from "./composables/use-chat-scroll-sync";
import { useChatSessionEffects } from "./composables/use-chat-session-effects";
import ChatMessage from "./components/ChatMessage.vue";
import StreamingDraftContainer from "./components/StreamingDraftContainer.vue";
import ChatInput from "./components/ChatInput.vue";
import {
  Loader2, Plus, Settings, Activity, History, MoreVertical, FileText,
  Download, ExternalLink, Copy, GitBranch, RefreshCcw, Wrench, Server, Plug, Bug,
  Monitor, MonitorOff, Cpu,
} from "lucide-vue-next";

import {
  getAutomationMode,
  setAutomationMode,
  onAutomationModeChange,
} from "../sw/kernel/automation-mode";

const props = defineProps<{
  listOpen: boolean;
}>();

const emit = defineEmits<{
  (e: "update:active-view", view: ViewMode): void;
  (e: "update:list-open", open: boolean): void;
  (e: "create-session"): void;
}>();

const store = useRuntimeStore();
const chatStore = useChatStore();
const cfgStore = useConfigStore();
const { loading } = storeToRefs(store);
const { error, config } = storeToRefs(cfgStore);
const { sessions, activeSessionId, messages, runtime, isRegeneratingTitle } = storeToRefs(chatStore);

function setErrorMessage(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err || "");
  error.value = message || fallback;
}

async function runSafely(task: () => Promise<void>, fallback: string) {
  try {
    await task();
  } catch (err) {
    setErrorMessage(err, fallback);
    console.error(err);
  }
}

const prompt = ref("");
const scrollContainer = ref<HTMLElement | null>(null);
const chatSceneOverlayRef = ref<HTMLElement | null>(null);
const showMoreMenu = ref(false);
const showToolHistory = ref(false);
const creatingSession = ref(false);
const moreMenuRef = ref(null);
const exportMenuRef = ref(null);
const automationMode = ref<"focus" | "background">("focus");

// Load initial mode and subscribe to changes
getAutomationMode().then((m) => { automationMode.value = m; });
const unsubMode = onAutomationModeChange((m) => { automationMode.value = m; });
onUnmounted(() => { unsubMode(); });
const isBackgroundMode = computed(() => automationMode.value === "background");

async function toggleAutomationMode() {
  const next = automationMode.value === "focus" ? "background" : "focus";
  await setAutomationMode(next);
  automationMode.value = next;
}

onClickOutside(moreMenuRef, () => showMoreMenu.value = false);

const runtimeLifecycle = computed(() => {
  const lifecycle = String(runtime.value?.lifecycle || "").trim().toLowerCase();
  if (lifecycle === "running" || lifecycle === "stopping" || lifecycle === "idle") {
    return lifecycle as "running" | "stopping" | "idle";
  }
  if (runtime.value?.running === true && runtime.value?.stopped === true) return "stopping";
  if (runtime.value?.running === true) return "running";
  return "idle";
});
const isStopping = computed(() => runtimeLifecycle.value === "stopping");
const isRunning = computed(() => runtimeLifecycle.value === "running");
const isRunActive = computed(() => runtimeLifecycle.value === "running" || runtimeLifecycle.value === "stopping");
const isCompacting = computed(() => isRunActive.value && runtime.value?.compacting === true);
const runtimeQueueState = computed(() => ({
  steer: Number(runtime.value?.queue?.steer || 0),
  followUp: Number(runtime.value?.queue?.followUp || 0),
  total: Number(runtime.value?.queue?.total || 0)
}));
const queuedPromptViewItems = computed<QueuedPromptViewItem[]>(() => {
  const rows = Array.isArray(runtime.value?.queue?.items) ? runtime.value?.queue?.items : [];
  const out: QueuedPromptViewItem[] = [];
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    const text = String(row?.text || "").trim();
    if (!id || !text) continue;
    out.push({
      id,
      behavior: row?.behavior === "steer" ? "steer" : "followUp",
      text,
      timestamp: String(row?.timestamp || "")
    });
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
});
const showBridgeOfflineDot = computed(() => bridgeConnectionStatus.value === "disconnected");
const activeSession = computed(() => sessions.value.find((item) => item.id === activeSessionId.value) || null);

const activeSessionTitle = computed(() => {
  const session = activeSession.value;
  return session?.title || "新对话";
});

const activeSessionSourceLabel = computed(() =>
  String((activeSession.value as { sourceLabel?: string } | null)?.sourceLabel || "")
    .trim()
    .toLowerCase(),
);

const activeForkSourceSessionId = computed(() =>
  String(activeSession.value?.forkedFrom?.sessionId || "").trim()
);

const activeForkSourceSession = computed(() => {
  const sourceId = activeForkSourceSessionId.value;
  if (!sourceId) return null;
  return sessions.value.find((item) => item.id === sourceId) || null;
});

const activeForkSourceTitle = computed(() => {
  const title = String(activeForkSourceSession.value?.title || "").trim();
  if (title) return title;
  const resolved = String(forkSourceResolvedTitle.value || "").trim();
  if (resolved) return resolved;
  return "未命名会话";
});

async function regenerateFromAssistantWithScene(
  entryId: string,
  options: { mode?: "fork" | "retry"; setActive?: boolean } = {}
) {
  const startedAt = Date.now();
  const result = await chatStore.regenerateFromAssistantEntry(entryId, {
    mode: options.mode,
    setActive: false
  });
  if (result.mode === "fork") {
    await switchForkSessionWithScene(result.sessionId, { startedAt });
  }
  return result;
}

const {
  copiedEntryId,
  retryingEntryId,
  forkingEntryId,
  pendingRegenerate,
  actionNotice,
  canCopyMessage,
  canRetryMessage,
  canForkMessage,
  handleCopyMessage,
  handleRetryMessage,
  handleForkMessage,
  cleanupMessageActions
} = useMessageActions({
  messages,
  isRunning: isRunActive,
  regenerateFromAssistantEntry: regenerateFromAssistantWithScene
});

const startRunPending = ref(false);
const {
  forkScenePhase,
  forkSceneSwitching,
  forkSessionHighlight,
  isForkSceneActive,
  chatSceneClass,
  forkSceneProgressClass,
  forkSceneIconClass,
  playForkSceneSwitch,
  switchForkSessionWithScene,
  bumpForkSceneToken,
  resetForkSceneState,
  isExpectedSwitch: isForkSceneExpectedSwitch,
  setHighlight: setForkSessionHighlight,
  cleanup: cleanupForkScene,
} = useForkScene({
  loadSession: (id) => chatStore.loadConversation(id, { setActive: true }),
});
const {
  editingUserEntryId,
  editingUserDraft,
  editingUserSubmitting,
  userPendingRegenerate,
  userForkingEntryId,
  resetEditingState,
  findLatestUserEntryId,
  canEditUserMessage,
  handleEditMessage,
  handleEditDraftChange,
  handleEditCancel,
  handleEditSubmit,
} = useMessageEditing({
  messages,
  loading,
  editUserMessageAndRerun: (entryId, content, opts) =>
    chatStore.editUserMessageAndRerun(entryId, content, opts),
  switchForkSession: switchForkSessionWithScene,
  cancelForkScene: () => { bumpForkSceneToken(); resetForkSceneState(); },
  onError: setErrorMessage,
});
const queuedPromotingIds = ref<Set<string>>(new Set());
const completedRunTimelineItems = ref<RunTimelineItem[]>([]);

function clearCompletedRunArtifacts() {
  completedRunTimelineItems.value = [];
}
// Forward references for llm-streaming functions (resolved after useLlmStreaming)
let _applyStreamEvent: (type: string, payload: Record<string, unknown>, sid: string) => import("./composables/use-llm-streaming").LlmStreamEventResult = () => ({ handled: false });
let _resetLlmStreamingState: () => void = () => {};
let _clearLiveRunTimeline: () => void = () => {};
let _getLiveRunTimelineItems: () => RunTimelineItem[] = () => [];
const {
  runPhase,
  toolPendingStepStates,
  activeRunToken,
  finalAssistantStreamingPhase,
  shouldShowToolPendingCard,
  hasRunningToolPendingActivity,
  hasToolPendingActivity,
  activeRunHint,
  setLlmRunHint,
  clearRunHint,
  clearActiveToolRun,
  clearToolPendingSteps,
  resetToolPendingCardHandoff,
  dismissToolPendingCardWithHandoff,
  stopInitialToolSync,
  startInitialToolSync,
  applyRuntimeEventToolRun,
  applyBridgeEventToolOutput,
  syncActiveToolRun,
  cleanup: cleanupToolRunTracking,
} = useToolRunTracking({
  activeSessionId,
  isRunActive,
  runSafely,
  applyStreamEvent: (type, payload, sid) => _applyStreamEvent(type, payload, sid),
  resetLlmStreamingState: () => _resetLlmStreamingState(),
  clearLiveRunTimeline: () => _clearLiveRunTimeline(),
  getLiveRunTimelineItems: () => _getLiveRunTimelineItems(),
  upsertLiveRunTimelineToolStep: (step) => upsertLiveRunTimelineToolStep(step),
  captureCompletedRunArtifacts: (items) => {
    completedRunTimelineItems.value = items.map((item) =>
      ({ ...item, logs: Array.isArray(item.logs) ? [...item.logs] : [] }),
    );
  },
  clearCompletedRunArtifacts,
});

const {
  llmStreamingText,
  llmStreamingSessionId,
  llmStreamingActive,
  llmStreamingPendingText,
  liveRunTimelineItems,
  shouldShowStreamingDraft,
  shouldShowStartPendingDraft,
  flushLlmStreamingDeltaBuffer,
  appendLlmStreamingDelta,
  commitPendingLlmStreamingText,
  clearLiveRunTimeline,
  getLiveRunTimelineItems,
  upsertLiveRunTimelineToolStep,
  resetLlmStreamingState,
  applyStreamEvent,
  cleanup: cleanupLlmStreaming,
} = useLlmStreaming({
  isRunActive,
  activeSessionId,
  messages,
  runPhase,
  startRunPending,
  shouldShowToolPendingCard,
});
_applyStreamEvent = applyStreamEvent;
_resetLlmStreamingState = resetLlmStreamingState;
_clearLiveRunTimeline = clearLiveRunTimeline;
_getLiveRunTimelineItems = () => getLiveRunTimelineItems();
const toolHistoryToggleLabel = computed(() =>
  showToolHistory.value ? "隐藏工具轨迹" : "显示工具轨迹"
);

const shouldShowCompletedRunTimeline = computed(() =>
  !isRunActive.value &&
  completedRunTimelineItems.value.length > 0 &&
  stableMessages.value.length > 0,
);

const liveRunTimelineStructureTokens = computed(() =>
  liveRunTimelineItems.value.map((item) =>
    `tool:${item.id}:${item.step}:${item.status}`,
  ),
);

const shouldShowLiveRunTimeline = computed(() =>
  liveRunTimelineItems.value.length > 0 && !finalAssistantStreamingPhase.value,
);

const shouldHideInlineToolMessages = computed(() =>
  shouldShowLiveRunTimeline.value,
);

const baseConversationMessages = computed<DisplayMessage[]>(() => {
  return (messages.value || [])
    .filter((item) => {
      const role = String(item?.role || "");
      if (role !== "tool") return true;
      if (shouldHideInlineToolMessages.value) return false;
      if (shouldAlwaysShowToolMessage(item)) return true;
      if (showToolHistory.value) return true;
      return false;
    })
    .map((item) => ({
      role: String(item?.role || ""),
      content: String(item?.content || ""),
      contentBlocks: item?.contentBlocks,
      entryId: String(item?.entryId || ""),
      toolName: String(item?.toolName || ""),
      toolCallId: String(item?.toolCallId || "")
    }));
});

const {
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
  cleanup: cleanupUiPipeline,
} = useUiRenderPipeline({
  sessions,
  activeSessionId,
  loading,
  getListOpen: () => props.listOpen,
  prompt,
  creatingSession,
  isStopping,
  isRunActive,
  isCompacting,
  activeSessionTitle,
  activeForkSourceSessionId,
  queuedPromptViewItems,
  runtimeQueueState,
  startRunPending,
  baseConversationMessages,
  actionNotice,
});

const {
  bridgeConnectionStatus,
  recentRuntimeEvents,
} = useRuntimeMessages({
  activeSessionId,
  isRunActive,
  chatSceneOverlayRef,
  panelUiRuntime,
  hydratePanelUiPlugins,
  applyUiExtensionLifecycleMessage,
  showActionNoticeWithPlugins,
  applyRuntimeEventToolRun,
  applyBridgeEventToolOutput,
  syncActiveToolRun,
  runSafely,
  loadConversation: (sessionId, options) => chatStore.loadConversation(sessionId, options),
  refreshSessions: () => chatStore.refreshSessions(),
});
const {
  forkSourceResolvedTitle,
} = useChatSessionEffects({
  queuedPromptViewItems,
  queuedPromotingIds,
  isRunActive,
  runPhase,
  activeRunToken,
  activeSessionId,
  activeSession,
  activeForkSourceSessionId,
  activeForkSourceSession,
  hasToolPendingActivity,
  hasRunningToolPendingActivity,
  llmStreamingActive,
  llmStreamingText,
  clearLiveRunTimeline,
  clearCompletedRunArtifacts,
  finalAssistantStreamingPhase,
  pendingRegenerate,
  userPendingRegenerate,
  messages,
  editingUserEntryId,
  startRunPending,
  clearToolPendingSteps,
  clearActiveToolRun,
  resetToolPendingCardHandoff,
  dismissToolPendingCardWithHandoff,
  startInitialToolSync,
  stopInitialToolSync,
  syncActiveToolRun,
  resetLlmStreamingState,
  clearRunHint,
  setLlmRunHint,
  resetEditingState,
  isExpectedForkSwitch: isForkSceneExpectedSwitch,
  bumpForkSceneToken,
  resetForkSceneState,
  setForkSessionHighlight,
  runSafely,
  notifyActiveSessionChanged: (nextId, prevId) =>
    panelUiRuntime.notifyActiveSessionChanged(nextId, prevId),
  emitUiSessionChanged: (payload) =>
    panelUiRuntime.runHook("ui.session.changed", payload),
});

const completedRunTimelineSummary = computed(() => {
  const toolCount = completedRunTimelineItems.value.filter((item) => item.kind === "tool").length;
  if (toolCount > 0) return `查看本轮执行过程（${toolCount}步）`;
  return `查看本轮执行过程`;
});

const latestAssistantMessageEntryId = computed(() => {
  for (let index = stableMessages.value.length - 1; index >= 0; index -= 1) {
    const item = stableMessages.value[index];
    if (String(item?.role || "") !== "assistant") continue;
    const entryId = String(item?.entryId || "").trim();
    if (entryId) return entryId;
  }
  return "";
});

useChatScrollSync({
  scrollContainer,
  stableMessages,
  shouldShowRunTimeline: shouldShowLiveRunTimeline,
  runTimelineStructureTokens: liveRunTimelineStructureTokens,
  shouldShowStreamingDraft,
  activeSessionId,
  activeRunToken,
  shouldShowToolPendingCard,
  llmStreamingText,
  isRunActive,
  toolPendingStepStates,
});
const {
  showExportMenu,
  publishingDebugLink,
  handleCopyMarkdown,
  handleCopyDebugLink,
  handleExport,
} = useConversationExport({
  activeSessionId,
  activeSessionTitle,
  messages,
  config,
  recentRuntimeEvents,
  showActionNoticeWithPlugins,
  setErrorMessage,
});
onClickOutside(exportMenuRef, () => showExportMenu.value = false);
const {
  handleCreateSession,
  handleJumpToForkSourceSession,
  handleRefreshSession,
  handleStopRun,
  handlePromoteQueuedPromptToSteer,
  handleSend,
} = useChatSendAction({
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
  panelUiRunHook: (hook, payload) => panelUiRuntime.runHook(hook, payload),
  chatStoreCreateSession: () => chatStore.createSession(),
  chatStoreRefreshSessions: () => chatStore.refreshSessions(),
  chatStoreRefreshSessionTitle: (id) => chatStore.refreshSessionTitle(id),
  chatStoreRunAction: (action) => chatStore.runAction(action),
  chatStorePromoteQueuedPromptToSteer: (id) => chatStore.promoteQueuedPromptToSteer(id),
  chatStoreSendPrompt: (text, opts) => chatStore.sendPrompt(text, opts),
  playForkSceneSwitch,
  emitUpdateListOpen: (open) => emit("update:list-open", open),
});

let stableMessagesRebuildPending = false;
watch(
  [baseConversationMessages, uiRenderEpoch],
  () => {
    if (stableMessagesRebuildPending) return;
    stableMessagesRebuildPending = true;
    void rebuildStableMessages().finally(() => {
      stableMessagesRebuildPending = false;
    });
  },
  { immediate: true }
);

watch(
  [sessions, activeSessionId, () => props.listOpen, loading, uiRenderEpoch],
  () => {
    void rebuildSessionListRenderState();
  },
  { immediate: true, deep: true }
);

watch(
  [activeSessionTitle, activeSessionId, isRunActive, isCompacting, activeForkSourceSessionId, uiRenderEpoch],
  () => {
    void rebuildHeaderRenderState();
  },
  { immediate: true }
);

watch(
  [queuedPromptViewItems, runtimeQueueState, activeSessionId, uiRenderEpoch],
  () => {
    void rebuildQueueRenderState();
  },
  { immediate: true, deep: true }
);

watch(
  [prompt, loading, creatingSession, isStopping, isRunActive, isCompacting, startRunPending, activeSessionId, uiRenderEpoch],
  () => {
    void rebuildChatInputRenderState();
  },
  { immediate: true }
);

const hasVisibleConversation = computed(() =>
  stableMessages.value.length > 0
  || shouldShowLiveRunTimeline.value
  || shouldShowStreamingDraft.value
  || shouldShowCompletedRunTimeline.value
  || shouldShowStartPendingDraft.value
);

onUnmounted(() => {
  cleanupUiPipeline();
  cleanupLlmStreaming();
  cleanupToolRunTracking();
  cleanupForkScene();
  cleanupMessageActions();
});

defineExpose({ handleCreateSession, sessionListRenderState });
</script>

<template>
  <main
    class="relative flex-1 flex flex-col min-w-0 min-h-0 bg-ui-bg"
    :aria-busy="isForkSceneActive ? 'true' : undefined"
  >
    <div v-if="loading && !hasVisibleConversation" class="absolute inset-0 z-40 flex items-center justify-center bg-white/80 dark:bg-neutral-900/80">
      <Loader2 class="animate-spin text-ui-accent" :size="24" />
    </div>

    <div
      class="relative flex h-full min-h-0 flex-col chat-scene"
      :class="chatSceneClass"
      :data-chat-scene-phase="forkScenePhase"
    >

    <header class="h-12 flex items-center px-3 shrink-0 border-b border-ui-border bg-ui-bg z-30" role="banner">
      <div class="flex-1 min-w-0 flex items-center gap-2">
        <div
          v-if="activeForkSourceSessionId"
          class="relative shrink-0 group"
        >
          <span
            tabindex="0"
            data-testid="fork-session-indicator"
            class="inline-flex h-6 w-6 items-center justify-center rounded-full border transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            :class="forkSessionHighlight
              ? 'text-ui-accent border-ui-accent/45 bg-ui-accent/10 shadow-[0_0_0_1px_rgba(37,99,235,0.08)]'
              : 'text-ui-text-muted border-ui-border/70 bg-ui-surface/60'"
            role="note"
            aria-label="当前会话来自分叉，悬浮可查看来源信息"
            title="分叉来源信息"
          >
            <GitBranch :size="11" :class="forkSessionHighlight ? 'animate-pulse' : ''" aria-hidden="true" />
          </span>
          <div
            class="pointer-events-none absolute left-0 top-full z-20 mt-1 w-64 max-w-[calc(100vw-24px)] rounded-md border border-ui-border bg-ui-bg px-3 py-2 opacity-0 shadow-xl transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          >
            <p class="text-[11px] font-semibold text-ui-text">分叉来源：{{ activeForkSourceTitle }}</p>
            <button
              type="button"
              class="mt-1 text-[11px] font-semibold text-ui-accent underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent rounded-sm"
              @click.stop="handleJumpToForkSourceSession"
            >
              跳回来源对话
            </button>
          </div>
        </div>
        <div class="flex-1 min-w-0 flex flex-col justify-center ml-1">
          <div v-if="!isRegeneratingTitle" class="flex items-center gap-2 min-w-0">
            <h1 class="min-w-0 text-[15px] font-bold text-ui-text truncate tracking-tight">
              {{ headerRenderState.title }}
            </h1>
            <span
              v-if="activeSessionSourceLabel === 'wechat'"
              class="inline-flex shrink-0 items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
              aria-label="当前会话来自微信"
            >
              微信
            </span>
          </div>
          <div v-else class="flex items-center gap-1.5 text-ui-accent">
            <span class="text-[13px] font-bold tracking-tight animate-pulse">正在重新生成标题</span>
            <span class="flex gap-0.5">
              <span class="animate-bounce [animation-delay:-0.3s]">.</span>
              <span class="animate-bounce [animation-delay:-0.15s]">.</span>
              <span class="animate-bounce">.</span>
            </span>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-0.5 shrink-0" role="toolbar" aria-label="会话操作">
        <button
          class="p-2 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :class="isBackgroundMode
            ? 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25'
            : 'text-ui-text hover:bg-ui-surface'"
          :title="isBackgroundMode ? '当前：后台模式（不抢焦点）' : '当前：前台模式（标准 CDP）'"
          :aria-label="isBackgroundMode ? '切换到前台模式' : '切换到后台模式'"
          :aria-pressed="isBackgroundMode"
          @click="toggleAutomationMode"
        >
          <MonitorOff v-if="isBackgroundMode" :size="18" aria-hidden="true" />
          <Monitor v-else :size="18" aria-hidden="true" />
        </button>
        <button
          class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          title="新建对话"
          aria-label="开始新对话"
          @click="handleCreateSession"
        >
          <Plus :size="20" aria-hidden="true" />
        </button>

        <button
          class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          title="会话历史"
          aria-label="查看会话历史列表"
          @click="emit('update:list-open', true)"
        >
          <History :size="18" aria-hidden="true" />
        </button>

        <!-- Export Menu -->
        <div class="relative" ref="exportMenuRef">
          <button
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            title="导出对话"
            :aria-label="showExportMenu ? '关闭导出菜单' : '打开导出菜单'"
            aria-haspopup="menu"
            :aria-expanded="showExportMenu"
            @click="showExportMenu = !showExportMenu"
          >
            <FileText :size="18" aria-hidden="true" />
          </button>
          <div 
            v-if="showExportMenu" 
            class="absolute right-0 mt-1 w-44 bg-ui-bg border border-ui-border rounded-lg shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100"
            role="menu"
          >
            <button role="menuitem" @click="handleCopyMarkdown" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
              <Copy :size="14" aria-hidden="true" /> 复制 Markdown
            </button>
            <button role="menuitem" @click="handleExport('download')" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left border-t border-ui-border/30 focus:bg-ui-surface outline-none">
              <Download :size="14" aria-hidden="true" /> 下载 MD 文件
            </button>
            <button role="menuitem" @click="handleExport('open')" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
              <ExternalLink :size="14" aria-hidden="true" /> 在标签页打开
            </button>
          </div>
        </div>

        <!-- More Menu -->
        <div class="relative" ref="moreMenuRef">
          <button
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            title="更多选项"
            :aria-label="showMoreMenu ? '关闭更多菜单' : '打开更多菜单'"
            aria-haspopup="menu"
            :aria-expanded="showMoreMenu"
            @click="showMoreMenu = !showMoreMenu"
          >
            <MoreVertical :size="18" aria-hidden="true" />
          </button>
          <div 
            v-if="showMoreMenu" 
            class="absolute right-0 mt-1 w-40 bg-ui-bg border border-ui-border rounded-lg shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100"
            role="menu"
          >
            <button role="menuitem" @click="handleCopyDebugLink(); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
              <ExternalLink :size="14" aria-hidden="true" /> 复制调试链接
            </button>
            <button role="menuitem" @click="handleRefreshSession(activeSessionId); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
              <RefreshCcw :size="14" aria-hidden="true" /> 重新生成标题
            </button>
            <button role="menuitem" @click="showToolHistory = !showToolHistory; showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
              <Activity :size="14" aria-hidden="true" /> {{ toolHistoryToggleLabel }}
            </button>
            <button role="menuitem" @click="emit('update:active-view', 'skills'); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
              <Wrench :size="14" aria-hidden="true" /> Skills 管理
            </button>
            <button role="menuitem" @click="emit('update:active-view', 'plugins'); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
              <Plug :size="14" aria-hidden="true" /> 插件
            </button>
            <button role="menuitem" @click="emit('update:active-view', 'mcp-settings'); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
              <Server :size="14" aria-hidden="true" /> MCP 服务器
            </button>
            <button role="menuitem" @click="emit('update:active-view', 'provider-settings'); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
              <Cpu :size="14" aria-hidden="true" /> 模型路由
            </button>
            <button role="menuitem" @click="emit('update:active-view', 'settings'); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
              <Settings :size="14" aria-hidden="true" /> 系统设置
            </button>
            <button role="menuitem" @click="emit('update:active-view', 'debug'); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
              <Bug :size="14" aria-hidden="true" /> 调试面板
            </button>
          </div>
        </div>
      </div>
    </header>

    <div
      v-if="actionNotice"
      role="alert"
      aria-live="polite"
      class="absolute top-14 left-1/2 z-30 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm"
      :class="actionNotice.type === 'success'
        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
        : 'bg-rose-50 text-rose-700 border-rose-200'"
    >
      {{ actionNotice.message }}
    </div>

    <div
      v-if="error"
      role="alert"
      class="absolute top-24 left-1/2 z-30 -translate-x-1/2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 shadow-sm"
    >
      {{ error }}
    </div>

    <div
      ref="chatSceneOverlayRef"
      data-ui-widget-slot="chat.scene.overlay"
      class="pointer-events-none absolute inset-0 z-20"
      aria-hidden="true"
    />

    <div
      ref="scrollContainer"
      class="flex-1 overflow-y-auto w-full min-h-0"
      role="log"
      aria-live="polite"
      aria-label="对话历史记录"
    >
      <div class="w-full px-5 pt-6 pb-8">
        <div v-if="hasVisibleConversation" class="space-y-2" role="list">
          <ChatMessage
            v-for="(msg, index) in stableMessages"
            :key="msg.entryId"
            :role="msg.role"
            :content="msg.content"
            :content-blocks="msg.contentBlocks"
            :entry-id="msg.entryId"
            :tool-name="msg.toolName"
            :tool-call-id="msg.toolCallId"
              :edit-disabled="loading || isRunActive"
              :copied="copiedEntryId === msg.entryId"
              :retrying="retryingEntryId === msg.entryId"
              :forking="forkingEntryId === msg.entryId || userForkingEntryId === msg.entryId"
              :show-edit-action="canEditUserMessage(msg)"
              :editing="editingUserEntryId === msg.entryId"
              :edit-draft="editingUserEntryId === msg.entryId ? editingUserDraft : ''"
              :edit-submitting="editingUserSubmitting && editingUserEntryId === msg.entryId"
              :copy-disabled="loading || !canCopyMessage(msg)"
              :retry-disabled="loading || isRunActive || !canRetryMessage(msg, index)"
              :fork-disabled="loading || isRunActive || !canForkMessage(msg, index)"
              :show-copy-action="canCopyMessage(msg)"
              :show-retry-action="canRetryMessage(msg, index)"
              :show-fork-action="canForkMessage(msg, index)"
              :show-execution-steps-action="shouldShowCompletedRunTimeline && msg.entryId === latestAssistantMessageEntryId"
              :execution-steps-label="completedRunTimelineSummary"
              :execution-timeline-items="shouldShowCompletedRunTimeline && msg.entryId === latestAssistantMessageEntryId ? completedRunTimelineItems : []"
              @copy="handleCopyMessage"
              @edit="handleEditMessage"
              @edit-change="handleEditDraftChange"
              @edit-cancel="handleEditCancel"
              @edit-submit="handleEditSubmit"
              @retry="handleRetryMessage"
              @fork="handleForkMessage"
            />

          <StreamingDraftContainer
            v-if="shouldShowStartPendingDraft"
            content=""
            :active="true"
            waiting-label="正在启动响应"
          />

          <template
            v-for="item in liveRunTimelineItems"
            :key="`live-${String(activeSessionId || '__global__')}-${activeRunToken}-${item.id}`"
          >
            <ChatMessage
              role="tool_pending"
              content=""
              :entry-id="`live-tool-${item.id}`"
              :tool-name="item.action"
              :tool-pending="true"
              :tool-pending-leaving="false"
              :tool-pending-status="item.status"
              :tool-pending-headline="item.headline"
              :tool-pending-action="item.action"
              :tool-pending-detail="item.detail"
              :tool-pending-steps-data="[{ step: item.step, status: item.status, line: item.line, logs: item.logs }]"
            />
          </template>

          <StreamingDraftContainer
            v-if="shouldShowStreamingDraft"
            :content="llmStreamingText"
            :active="llmStreamingActive"
            :waiting-label="isCompacting ? '正在整理上下文' : (activeRunHint?.label || '等待模型响应')"
          />

        </div>

        <div v-else class="flex flex-col items-start py-8 animate-in fade-in duration-500">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-10 h-10 bg-ui-accent/5 rounded-xl flex items-center justify-center border border-ui-accent/10">
              <Activity :size="20" class="text-ui-accent" />
            </div>
            <h2 class="text-xl font-black uppercase tracking-tight text-ui-text">Agent Terminal</h2>
          </div>
          <p class="text-ui-text-muted text-[15px] leading-relaxed max-w-xs font-bold">
            就绪。发送消息让 Agent 帮你完成浏览器任务。
          </p>
        </div>
      </div>
    </div>

    <div class="shrink-0 w-full bg-ui-bg z-20">
      <ChatInput
        v-model="prompt"
        :placeholder="chatInputRenderState.placeholder"
        :is-running="isRunning"
        :is-compacting="isCompacting"
        :is-starting-run="startRunPending && !isRunActive"
        :queue-items="queueRenderState.items"
        :queue-promoting-ids="Array.from(queuedPromotingIds)"
        :queue-state="queueRenderState.state"
        :disabled="loading || creatingSession || isStopping"
        @send="handleSend"
        @queue-promote="handlePromoteQueuedPromptToSteer($event.id)"
        @stop="handleStopRun"
      />
    </div>

    <div
      v-if="showBridgeOfflineDot"
      class="absolute bottom-3 right-3 z-20"
      role="status"
      aria-live="polite"
      aria-label="Bridge 未连接"
      title="Bridge 未连接"
    >
      <span class="inline-flex h-2.5 w-2.5 rounded-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.45)]" aria-hidden="true"></span>
    </div>

    </div>

    <div
      v-if="isForkSceneActive"
      class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
      data-testid="chat-fork-switch-overlay"
      :data-phase="forkScenePhase"
      aria-hidden="true"
    >
      <div class="absolute inset-0 bg-ui-bg/60 backdrop-blur-[2px]" />
      <div class="relative inline-flex items-center gap-3 rounded-full border border-ui-accent/20 bg-ui-bg/85 px-3 py-2 shadow-[0_12px_30px_rgba(15,23,42,0.18)]">
        <span class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-ui-accent/30 bg-ui-accent/10 text-ui-accent">
          <GitBranch :size="13" :class="forkSceneIconClass" aria-hidden="true" />
        </span>
        <span class="h-1.5 w-[74px] overflow-hidden rounded-full bg-ui-accent/20">
          <span
            class="block h-full rounded-full bg-ui-accent transition-[width] duration-180 ease-out"
            :class="forkSceneProgressClass"
          />
        </span>
      </div>
    </div>
  </main>
</template>

<style scoped>
.chat-scene {
  will-change: transform, opacity, filter;
  transform-origin: center;
  transition:
    transform 170ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 170ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 170ms cubic-bezier(0.22, 1, 0.36, 1);
}

.chat-scene--prepare {
  transform: scale(0.994) translateY(1px);
}

.chat-scene--leave {
  transform: translateX(-18px) scale(0.986);
  opacity: 0;
  filter: blur(1.2px);
}

.chat-scene--enter {
  animation: chat-scene-enter 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes chat-scene-enter {
  from {
    transform: translateX(20px) scale(0.986);
    opacity: 0;
    filter: blur(1.2px);
  }

  to {
    transform: translateX(0) scale(1);
    opacity: 1;
    filter: blur(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chat-scene,
  .chat-scene--enter {
    animation: none !important;
    transition: none !important;
    transform: none !important;
    opacity: 1 !important;
    filter: none !important;
  }
}
</style>
