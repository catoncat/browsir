<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from "vue";
import { useRuntimeStore } from "./stores/runtime";
import { useMessageActions, type PanelMessageLike, type PendingRegenerateState } from "./utils/message-actions";

import SessionList from "./components/SessionList.vue";
import ChatMessage from "./components/ChatMessage.vue";
import ChatInput from "./components/ChatInput.vue";
import SettingsView from "./components/SettingsView.vue";
import DebugView from "./components/DebugView.vue";
import { Loader2, Plus, Settings, Bug, Activity, History, MoreVertical, FileUp, Download, ExternalLink, Copy, GitBranch } from "lucide-vue-next";
import { onClickOutside } from "@vueuse/core";

const store = useRuntimeStore();
const { loading, error, sessions, activeSessionId, messages, runtime, health } = storeToRefs(store);

const prompt = ref("");
const scrollContainer = ref<HTMLElement | null>(null);
const listOpen = ref(false);
const showSettings = ref(false);
const showDebug = ref(false);
const showMoreMenu = ref(false);
const showExportMenu = ref(false);
const moreMenuRef = ref(null);
const exportMenuRef = ref(null);

onClickOutside(moreMenuRef, () => showMoreMenu.value = false);
onClickOutside(exportMenuRef, () => showExportMenu.value = false);

const isRunning = computed(() => Boolean(runtime.value?.running && !runtime.value?.stopped));
const hasBridge = computed(() => Boolean(health.value.bridgeUrl));
const activeSession = computed(() => sessions.value.find((item) => item.id === activeSessionId.value) || null);

const activeSessionTitle = computed(() => {
  const session = activeSession.value;
  return session?.title || "新对话";
});

const activeForkSourceText = computed(() => {
  const sourceId = String(activeSession.value?.forkedFrom?.sessionId || "").trim();
  if (!sourceId) return "";
  const tail = sourceId.length > 8 ? sourceId.slice(-8) : sourceId;
  return `分叉自 ${tail}`;
});

interface DisplayMessage extends PanelMessageLike {
  role: string;
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
  toolPending?: boolean;
  toolPendingAction?: string;
  toolPendingDetail?: string;
  toolPendingLogs?: string[];
  busyPlaceholder?: boolean;
  busyMode?: "retry" | "fork";
  busySourceEntryId?: string;
}

interface StepTraceRecord {
  type?: string;
  timestamp?: string;
  ts?: string;
  payload?: Record<string, unknown>;
}

interface ToolRunSnapshot {
  step: number;
  action: string;
  arguments: string;
  ts: string;
}

interface RuntimeProgressHint {
  phase: "llm" | "tool";
  label: string;
  detail: string;
  ts: string;
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
  isRunning,
  regenerateFromAssistantEntry: store.regenerateFromAssistantEntry
});

const editingUserEntryId = ref("");
const editingUserDraft = ref("");
const editingUserSubmitting = ref(false);
const userPendingRegenerate = ref<PendingRegenerateState | null>(null);
const userForkingEntryId = ref("");
const forkScenePhase = ref<"idle" | "prepare" | "leave" | "swap" | "enter">("idle");
const forkSceneToken = ref(0);
const forkSceneSwitching = ref(false);
const forkSceneTargetSessionId = ref("");
const forkSessionHighlight = ref(false);
const activeToolRun = ref<ToolRunSnapshot | null>(null);
const activeRunHint = ref<RuntimeProgressHint | null>(null);
const toolPendingLogs = ref<string[]>([]);
const activeRunToken = ref(0);
let forkSessionHighlightTimer: ReturnType<typeof setTimeout> | null = null;

const USER_FORK_MIN_VISIBLE_MS = 620;
const USER_FORK_SCENE_PREPARE_MS = 140;
const USER_FORK_SCENE_LEAVE_MS = 170;
const USER_FORK_SCENE_ENTER_MS = 240;
const FORK_SWITCH_HIGHLIGHT_MS = 1800;
const TOOL_STREAM_SYNC_INTERVAL_MS = 3200;
const TOOL_LOG_MAX_LINES = 120;
const MAIN_SCROLL_BOTTOM_THRESHOLD_PX = 120;

const isForkSceneActive = computed(() => forkScenePhase.value !== "idle");

const chatSceneClass = computed(() => ({
  "chat-scene--prepare": forkScenePhase.value === "prepare",
  "chat-scene--leave": forkScenePhase.value === "leave" || forkScenePhase.value === "swap",
  "chat-scene--enter": forkScenePhase.value === "enter"
}));

const forkSceneProgressClass = computed(() => {
  if (forkScenePhase.value === "prepare") return "w-[30%]";
  if (forkScenePhase.value === "enter") return "w-full";
  return "w-[74%]";
});

const forkSceneIconClass = computed(() => (
  forkScenePhase.value === "enter" ? "animate-pulse" : "animate-spin"
));

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function setForkSessionHighlight(active: boolean) {
  forkSessionHighlight.value = active;
}

function triggerForkSessionHighlight() {
  if (forkSessionHighlightTimer) {
    clearTimeout(forkSessionHighlightTimer);
    forkSessionHighlightTimer = null;
  }
  setForkSessionHighlight(true);
  forkSessionHighlightTimer = setTimeout(() => {
    setForkSessionHighlight(false);
    forkSessionHighlightTimer = null;
  }, FORK_SWITCH_HIGHLIGHT_MS);
}

function bumpForkSceneToken() {
  forkSceneToken.value += 1;
  return forkSceneToken.value;
}

function isForkSceneStale(token: number) {
  return token !== forkSceneToken.value;
}

function resetForkSceneState() {
  forkScenePhase.value = "idle";
  forkSceneSwitching.value = false;
  forkSceneTargetSessionId.value = "";
}

async function playForkSceneSwitch(targetSessionId: string) {
  const normalizedTargetSessionId = String(targetSessionId || "").trim();
  if (!normalizedTargetSessionId) return;

  const token = bumpForkSceneToken();
  forkSceneSwitching.value = true;
  forkSceneTargetSessionId.value = normalizedTargetSessionId;

  try {
    forkScenePhase.value = "prepare";
    await sleep(USER_FORK_SCENE_PREPARE_MS);
    if (isForkSceneStale(token)) return;

    forkScenePhase.value = "leave";
    await sleep(USER_FORK_SCENE_LEAVE_MS);
    if (isForkSceneStale(token)) return;

    forkScenePhase.value = "swap";
    await store.loadConversation(normalizedTargetSessionId, { setActive: true });
    if (isForkSceneStale(token)) return;

    triggerForkSessionHighlight();
    await nextTick();

    forkScenePhase.value = "enter";
    await sleep(USER_FORK_SCENE_ENTER_MS);
  } finally {
    if (!isForkSceneStale(token)) {
      resetForkSceneState();
    }
  }
}

function resetEditingState() {
  editingUserEntryId.value = "";
  editingUserDraft.value = "";
  editingUserSubmitting.value = false;
  userForkingEntryId.value = "";
}

function findLatestUserEntryId(items: PanelMessageLike[]) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const candidate = items[i];
    if (candidate?.role !== "user") continue;
    const entryId = String(candidate?.entryId || "").trim();
    if (!entryId) continue;
    if (!String(candidate?.content || "").trim()) continue;
    return entryId;
  }
  return "";
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeStep(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeEventTs(row: Record<string, unknown>): string {
  return String(row.ts || row.timestamp || new Date().toISOString());
}

function prettyToolAction(action: string): string {
  const normalized = String(action || "").trim().toLowerCase();
  const map: Record<string, string> = {
    snapshot: "读取页面快照",
    list_tabs: "检索标签页",
    open_tab: "打开标签页",
    browser_action: "执行浏览器动作",
    browser_verify: "执行页面验证",
    read_file: "读取文件",
    write_file: "写入文件",
    edit_file: "编辑文件",
    bash: "执行命令"
  };
  return map[normalized] || (normalized ? `执行 ${normalized}` : "执行工具");
}

function clipText(text: string, max = 96): string {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function toScalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function tryParseArgs(raw: string): Record<string, unknown> | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formatToolPendingDetail(action: string, argsRaw: string): string {
  const normalized = String(action || "").trim().toLowerCase();
  const raw = String(argsRaw || "").trim();
  const args = tryParseArgs(raw);

  if (normalized === "list_tabs") return "正在读取当前窗口标签页信息";
  if (normalized === "bash") {
    const command = toScalarText(args?.command) || raw;
    return command ? `命令：${clipText(command, 100)}` : "";
  }
  if (["read_file", "write_file", "edit_file"].includes(normalized)) {
    const path = toScalarText(args?.path);
    return path ? `路径：${clipText(path, 100)}` : "";
  }
  if (normalized === "open_tab") {
    const url = toScalarText(args?.url);
    return url ? `目标：${clipText(url, 100)}` : "";
  }
  if (normalized === "snapshot") {
    const mode = toScalarText(args?.mode) || "interactive";
    const selector = toScalarText(args?.selector);
    const detail = selector ? `模式：${mode} · 选择器：${clipText(selector, 64)}` : `模式：${mode}`;
    return detail;
  }
  if (normalized === "browser_action") {
    const kind = toScalarText(args?.kind);
    const target = toScalarText(args?.url) || toScalarText(args?.ref) || toScalarText(args?.selector);
    if (kind && target) return `${kind} · ${clipText(target, 88)}`;
    if (kind) return `动作：${kind}`;
  }
  if (normalized === "browser_verify") {
    return "正在校验页面状态";
  }

  if (raw) return `参数：${clipText(raw, 110)}`;
  return "";
}

function clearActiveToolRun() {
  activeToolRun.value = null;
}

function clearToolPendingLogs() {
  toolPendingLogs.value = [];
}

function appendToolPendingLogs(stream: "stdout" | "stderr", chunk: string) {
  const raw = String(chunk || "");
  if (!raw) return;
  const parts = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (!parts.length) return;

  const normalized = parts.map((line) => (stream === "stderr" ? `stderr | ${line}` : line));
  const merged = [...toolPendingLogs.value, ...normalized];
  if (merged.length > TOOL_LOG_MAX_LINES) {
    merged.splice(0, merged.length - TOOL_LOG_MAX_LINES);
  }
  toolPendingLogs.value = merged;
}

function setLlmRunHint(label: string, detail = "") {
  activeRunHint.value = {
    phase: "llm",
    label: String(label || "").trim() || "思考中",
    detail: String(detail || "").trim(),
    ts: new Date().toISOString()
  };
}

function setToolRunHint(action: string, argsRaw: string, ts: string) {
  activeRunHint.value = {
    phase: "tool",
    label: prettyToolAction(action),
    detail: formatToolPendingDetail(action, argsRaw),
    ts: String(ts || new Date().toISOString())
  };
}

function deriveActiveToolRunFromStream(stream: StepTraceRecord[]): ToolRunSnapshot | null {
  const pendingByStep = new Map<number, ToolRunSnapshot>();
  for (const row of stream || []) {
    const type = String(row?.type || "");
    const payload = toRecord(row?.payload);
    const mode = String(payload.mode || "");
    if (type === "step_planned" && mode === "tool_call") {
      const step = normalizeStep(payload.step);
      if (!step) continue;
      pendingByStep.set(step, {
        step,
        action: String(payload.action || ""),
        arguments: String(payload.arguments || ""),
        ts: normalizeEventTs(toRecord(row))
      });
      continue;
    }
    if (type === "step_finished" && mode === "tool_call") {
      const step = normalizeStep(payload.step);
      if (!step) continue;
      pendingByStep.delete(step);
      continue;
    }
    if (["loop_done", "loop_error", "loop_skip_stopped", "loop_internal_error"].includes(type)) {
      pendingByStep.clear();
    }
  }
  let latest: ToolRunSnapshot | null = null;
  for (const item of pendingByStep.values()) {
    if (!latest || item.step >= latest.step) latest = item;
  }
  return latest;
}

function applyRuntimeEventToolRun(event: unknown) {
  const envelope = toRecord(event);
  const type = String(envelope.type || "");
  const payload = toRecord(envelope.payload);
  const mode = String(payload.mode || "");
  const ts = normalizeEventTs(envelope);
  if (type === "loop_start") {
    activeToolRun.value = null;
    clearToolPendingLogs();
    setLlmRunHint("分析任务", "正在规划下一步动作");
    return;
  }
  if (type === "llm.request") {
    setLlmRunHint("调用模型", "正在生成下一步计划");
    return;
  }
  if (type === "llm.response.parsed") {
    const toolCalls = Number(payload.toolCalls || 0);
    if (!(Number.isFinite(toolCalls) && toolCalls > 0)) {
      setLlmRunHint("整理回复", "正在生成最终回答");
    }
    return;
  }
  if (type === "step_planned" && mode === "tool_call") {
    const step = normalizeStep(payload.step);
    if (!step) return;
    clearToolPendingLogs();
    activeToolRun.value = {
      step,
      action: String(payload.action || ""),
      arguments: String(payload.arguments || ""),
      ts
    };
    setToolRunHint(String(payload.action || ""), String(payload.arguments || ""), ts);
    return;
  }
  if (type === "step_finished" && mode === "tool_call") {
    const step = normalizeStep(payload.step);
    if (!step) return;
    if (activeToolRun.value && activeToolRun.value.step === step) {
      activeToolRun.value = null;
    }
    clearToolPendingLogs();
    setLlmRunHint("继续推理", "正在处理工具结果");
    return;
  }
  if (["loop_done", "loop_error", "loop_skip_stopped", "loop_internal_error", "loop_start"].includes(type)) {
    activeToolRun.value = null;
    clearToolPendingLogs();
    activeRunHint.value = null;
  }
}

function applyBridgeEventToolOutput(rawEvent: unknown) {
  const envelope = toRecord(rawEvent);
  const eventSessionId = String(envelope.sessionId || "").trim();
  if (!eventSessionId || eventSessionId !== String(activeSessionId.value || "").trim()) return;
  if (!isRunning.value) return;
  const eventName = String(envelope.event || "").trim();
  const data = toRecord(envelope.data);

  if (eventName === "invoke.started") {
    clearToolPendingLogs();
    return;
  }
  if (eventName === "invoke.stdout") {
    appendToolPendingLogs("stdout", String(data.chunk || ""));
    return;
  }
  if (eventName === "invoke.stderr") {
    appendToolPendingLogs("stderr", String(data.chunk || ""));
  }
}

async function syncActiveToolRun(sessionId: string) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return;
  const response = (await chrome.runtime.sendMessage({
    type: "brain.step.stream",
    sessionId: normalizedSessionId
  })) as { ok?: boolean; data?: { stream?: StepTraceRecord[] }; error?: string };
  if (!response?.ok) {
    throw new Error(String(response?.error || "读取 step stream 失败"));
  }
  const stream = Array.isArray(response?.data?.stream) ? response.data?.stream || [] : [];
  const latest = deriveActiveToolRunFromStream(stream);
  activeToolRun.value = latest;
  if (latest) {
    setToolRunHint(latest.action, latest.arguments, latest.ts);
  } else if (isRunning.value && !activeRunHint.value) {
    setLlmRunHint("思考中", "正在分析你的请求");
  }
}

const runningStatus = computed(() => {
  if (!isRunning.value) return null;
  if (activeToolRun.value) {
    return {
      action: prettyToolAction(activeToolRun.value.action),
      detail: formatToolPendingDetail(activeToolRun.value.action, activeToolRun.value.arguments)
    };
  }
  return {
    action: activeRunHint.value?.label || "思考中",
    detail: activeRunHint.value?.detail || "正在分析你的请求"
  };
});

const displayMessages = computed<DisplayMessage[]>(() => {
  const rendered = (messages.value || []).map((item) => ({
    role: String(item?.role || ""),
    content: String(item?.content || ""),
    entryId: String(item?.entryId || ""),
    toolName: String(item?.toolName || ""),
    toolCallId: String(item?.toolCallId || "")
  }));
  const pending = pendingRegenerate.value || userPendingRegenerate.value;
  if (pending) {
    const placeholder: DisplayMessage = {
      role: "assistant_placeholder",
      content: "正在重新生成回复…",
      entryId: `__regen_placeholder__${pending.mode}__${pending.sourceEntryId}`,
      busyPlaceholder: true,
      busyMode: pending.mode,
      busySourceEntryId: pending.sourceEntryId
    };

    const replaceMode = pending.strategy ? pending.strategy === "replace" : pending.mode === "retry";
    if (replaceMode) {
      const targetIndex = rendered.findIndex(
        (item) => item.role === "assistant" && item.entryId === pending.sourceEntryId
      );
      if (targetIndex >= 0) {
        rendered.splice(targetIndex, 1, placeholder);
      } else {
        rendered.push(placeholder);
      }
    } else {
      const anchorIndex = rendered.findIndex((item) => item.entryId === pending.insertAfterUserEntryId);
      if (anchorIndex >= 0) {
        rendered.splice(anchorIndex + 1, 0, placeholder);
      } else {
        rendered.push(placeholder);
      }
    }
  }

  if (isRunning.value && runningStatus.value) {
    rendered.push({
      role: "tool_pending",
      content: "",
      entryId: `__tool_pending__${String(activeSessionId.value || "__global__")}__${activeRunToken.value}`,
      toolName: activeToolRun.value?.action || "llm",
      toolPending: true,
      toolPendingAction: runningStatus.value.action,
      toolPendingDetail: runningStatus.value.detail,
      toolPendingLogs: toolPendingLogs.value
    });
  }

  return rendered;
});

watch(isRunning, (running, wasRunning) => {
  if (running) {
    if (!wasRunning) {
      activeRunToken.value += 1;
      clearToolPendingLogs();
    }
    if (!activeRunHint.value) {
      setLlmRunHint("思考中", "正在分析你的请求");
    }
    if (activeSessionId.value) {
      void runSafely(
        () => syncActiveToolRun(activeSessionId.value),
        "同步工具运行状态失败"
      );
    }
    return;
  }
  userPendingRegenerate.value = null;
  clearActiveToolRun();
  clearToolPendingLogs();
  activeRunHint.value = null;
});

watch(activeSessionId, () => {
  const currentSessionId = String(activeSessionId.value || "").trim();
  const isExpectedForkSwitch =
    forkSceneSwitching.value &&
    currentSessionId.length > 0 &&
    currentSessionId === forkSceneTargetSessionId.value;
  if (!isExpectedForkSwitch) {
    bumpForkSceneToken();
    resetForkSceneState();
  }
  clearActiveToolRun();
  clearToolPendingLogs();
  activeRunHint.value = null;
  if (!activeSession.value?.forkedFrom?.sessionId) {
    setForkSessionHighlight(false);
  }
  resetEditingState();
  if (activeSessionId.value && isRunning.value) {
    void runSafely(
      () => syncActiveToolRun(activeSessionId.value),
      "同步工具运行状态失败"
    );
  }
});

watch(
  messages,
  (list) => {
    if (!editingUserEntryId.value) return;
    const exists = list.some((item) => String(item?.entryId || "") === editingUserEntryId.value);
    if (!exists) resetEditingState();
  },
  { deep: true }
);

function isMainScrollNearBottom() {
  const el = scrollContainer.value;
  if (!el) return true;
  const remain = el.scrollHeight - el.scrollTop - el.clientHeight;
  return remain <= MAIN_SCROLL_BOTTOM_THRESHOLD_PX;
}

const displayMessageStructureKey = computed(() =>
  displayMessages.value.map((item) => `${item.role}:${item.entryId}`).join("|")
);

watch(displayMessageStructureKey, async () => {
  const shouldFollow = isMainScrollNearBottom();
  await nextTick();
  if (shouldFollow && scrollContainer.value) {
    scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
  }
});

function setErrorMessage(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err || "");
  error.value = message || fallback;
}

function canEditUserMessage(message: PanelMessageLike) {
  if (message?.role !== "user") return false;
  return String(message?.content || "").trim().length > 0;
}

async function handleEditMessage(payload: { entryId: string; content: string; role: string }) {
  if (payload?.role !== "user") return;
  if (loading.value || editingUserSubmitting.value) return;
  const content = String(payload?.content || "").trim();
  if (!content) return;
  editingUserEntryId.value = String(payload?.entryId || "").trim();
  editingUserDraft.value = String(payload?.content || "");
}

function handleEditDraftChange(payload: { entryId: string; content: string }) {
  if (editingUserSubmitting.value) return;
  const entryId = String(payload?.entryId || "").trim();
  if (!entryId || editingUserEntryId.value !== entryId) return;
  editingUserDraft.value = String(payload?.content || "");
}

function handleEditCancel(payload: { entryId: string }) {
  if (editingUserSubmitting.value) return;
  const entryId = String(payload?.entryId || "").trim();
  if (!entryId || editingUserEntryId.value !== entryId) return;
  resetEditingState();
}

async function handleEditSubmit(payload: { entryId: string; content: string; role: string }) {
  if (payload?.role !== "user") return;
  if (loading.value || editingUserSubmitting.value) return;
  const entryId = String(payload?.entryId || "").trim();
  if (!entryId || editingUserEntryId.value !== entryId) return;
  const content = String(payload?.content || "").trim();
  if (!content) return;

  const startedAt = Date.now();
  editingUserSubmitting.value = true;
  const latestUserEntryIdBeforeSubmit = findLatestUserEntryId(messages.value);
  const predictedMode: "retry" | "fork" = latestUserEntryIdBeforeSubmit === entryId ? "retry" : "fork";
  if (predictedMode === "fork") {
    userForkingEntryId.value = entryId;
  }
  userPendingRegenerate.value = {
    mode: predictedMode,
    sourceEntryId: entryId,
    insertAfterUserEntryId: entryId,
    strategy: "insert"
  };
  try {
    const result = await store.editUserMessageAndRerun(entryId, content, { setActive: false });
    const latestUserEntryId = findLatestUserEntryId(messages.value);
    const sourceEntryId = String(result.activeSourceEntryId || entryId || "").trim();
    const anchorEntryId = latestUserEntryId || sourceEntryId;
    userPendingRegenerate.value = anchorEntryId
      ? {
          mode: result.mode,
          sourceEntryId,
          insertAfterUserEntryId: anchorEntryId,
          strategy: "insert"
        }
      : null;

    if (result.mode === "fork") {
      const elapsed = Date.now() - startedAt;
      if (elapsed < USER_FORK_MIN_VISIBLE_MS) {
        await sleep(USER_FORK_MIN_VISIBLE_MS - elapsed);
      }
      await playForkSceneSwitch(result.sessionId);
    }

    resetEditingState();
  } catch (err) {
    userPendingRegenerate.value = null;
    bumpForkSceneToken();
    resetForkSceneState();
    setErrorMessage(err, "编辑并重跑失败");
    console.error(err);
  } finally {
    editingUserSubmitting.value = false;
    if (!editingUserEntryId.value) {
      userForkingEntryId.value = "";
    }
  }
}

async function runSafely(task: () => Promise<void>, fallback: string) {
  try {
    await task();
  } catch (err) {
    setErrorMessage(err, fallback);
    console.error(err);
  }
}

const onRuntimeMessage = (message: unknown) => {
  const payload = message as {
    type?: string;
    event?: { sessionId?: string };
    payload?: { sessionId?: string; event?: string; data?: Record<string, unknown> };
  };

  if (payload?.type === "bridge.event") {
    applyBridgeEventToolOutput(payload.payload);
    return;
  }

  if (payload?.type !== "brain.event") return;
  const eventSessionId = String(payload?.event?.sessionId || "").trim();
  if (!eventSessionId) return;

  if (eventSessionId === activeSessionId.value) {
    applyRuntimeEventToolRun(payload.event);
    void runSafely(
      () => store.loadConversation(eventSessionId, { setActive: false }),
      "刷新会话失败"
    );
    return;
  }

  void runSafely(() => store.refreshSessions(), "刷新会话列表失败");
};

onMounted(() => {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  void runSafely(async () => {
    await store.bootstrap();
    if (activeSessionId.value && isRunning.value) {
      await syncActiveToolRun(activeSessionId.value);
    }
  }, "初始化失败");
});

useIntervalFn(() => {
  if (!activeSessionId.value || !isRunning.value) return;
  void runSafely(
    async () => {
      await Promise.all([
        store.loadConversation(activeSessionId.value, { setActive: false }),
        syncActiveToolRun(activeSessionId.value)
      ]);
    },
    "轮询会话失败"
  );
}, TOOL_STREAM_SYNC_INTERVAL_MS);

async function handleCreateSession() {
  await runSafely(async () => {
    await store.createSession();
    listOpen.value = false;
  }, "新建会话失败");
}

async function handleSelectSession(id: string) {
  await runSafely(async () => {
    await store.loadConversation(id, { setActive: true });
    listOpen.value = false;
  }, "切换会话失败");
}

async function handleDeleteSession(id: string) {
  await runSafely(() => store.deleteSession(id), "删除会话失败");
}

async function handleRefreshSession(id: string) {
  await runSafely(() => store.refreshSessionTitle(id), "刷新标题失败");
}

async function handleStopRun() {
  await runSafely(() => store.runAction("brain.run.stop"), "停止任务失败");
}

async function handleSend(payload: { text: string; tabIds: number[] }) {
  const text = String(payload.text || "");
  if (!text.trim()) return;
  const isNew = !activeSessionId.value;

  try {
    await store.sendPrompt(text, {
      newSession: isNew,
      tabIds: Array.isArray(payload.tabIds) ? payload.tabIds : []
    });
    prompt.value = "";
  } catch (err) {
    setErrorMessage(err, "发送失败");
  }
}

function generateMarkdown() {
  const title = activeSessionTitle.value;
  let md = `# ${title}\n\n`;
  
  messages.value.forEach(msg => {
    if (msg.role === 'user') {
      md += `**User**: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      // 简单过滤，只保留文本对话内容
      const content = msg.content.trim();
      if (content) {
        md += `**Assistant**: ${content}\n\n`;
      }
    }
  });
  
  return md;
}

async function handleCopyMarkdown() {
  const md = generateMarkdown();
  try {
    await navigator.clipboard.writeText(md);
    actionNotice.value = { type: 'success', message: '已复制到剪贴板' };
    setTimeout(() => { actionNotice.value = null; }, 2000);
  } catch (err) {
    setErrorMessage(err, '复制失败');
  }
  showExportMenu.value = false;
}

function handleExport(mode: 'download' | 'open') {
  const md = generateMarkdown();
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  if (mode === 'download') {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSessionTitle.value.replace(/\s+/g, '_')}.md`;
    a.click();
    // 下载后延迟释放，确保浏览器完成操作
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else {
    // 使用 text/markdown MIME 类型的 Blob URL。
    // 很多 Markdown Viewer 插件会拦截此 MIME 类型的 blob 链接。
    // 我们不立即调用 revokeObjectURL，给新标签页留出加载时间。
    chrome.tabs.create({ url });
    // 10秒后自动释放，防止内存泄露，但也足够插件加载了
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  
  showExportMenu.value = false;
}

onUnmounted(() => {
  if (forkSessionHighlightTimer) {
    clearTimeout(forkSessionHighlightTimer);
    forkSessionHighlightTimer = null;
  }
  bumpForkSceneToken();
  resetForkSceneState();
  clearActiveToolRun();
  clearToolPendingLogs();
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  cleanupMessageActions();
});
</script>

<template>
  <div class="h-full min-h-0 flex flex-col bg-ui-bg text-ui-text font-sans selection:bg-ui-accent/10 border-none m-0 p-0 overflow-hidden">
    <SessionList
      v-if="listOpen"
      :is-open="listOpen"
      :sessions="sessions"
      :active-id="activeSessionId"
      :loading="loading"
      @close="listOpen = false"
      @new="handleCreateSession"
      @select="handleSelectSession"
      @delete="handleDeleteSession"
      @refresh="handleRefreshSession"
    />

    <SettingsView v-if="showSettings" @close="showSettings = false" />
    <DebugView v-if="showDebug" @close="showDebug = false" />

    <main
      class="relative flex-1 flex flex-col min-w-0 min-h-0 bg-ui-bg"
      :aria-busy="isForkSceneActive ? 'true' : undefined"
    >
      <div v-if="loading && !displayMessages.length" class="absolute inset-0 z-40 flex items-center justify-center bg-white/80">
        <Loader2 class="animate-spin text-ui-accent" :size="24" />
      </div>

      <div
        class="relative flex h-full min-h-0 flex-col chat-scene"
        :class="chatSceneClass"
        :data-chat-scene-phase="forkScenePhase"
      >

      <header class="h-12 flex items-center px-3 shrink-0 border-b border-ui-border bg-ui-bg z-30" role="banner">
        <div class="flex-1 overflow-hidden flex items-center gap-2">
          <h1 class="text-[15px] font-bold text-ui-text truncate tracking-tight ml-1">
            {{ activeSessionTitle }}
          </h1>
          <span
            v-if="activeForkSourceText"
            class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-all duration-200"
            :class="forkSessionHighlight
              ? 'text-ui-accent border-ui-accent/40 bg-ui-accent/10 shadow-[0_0_0_1px_rgba(37,99,235,0.08)]'
              : 'text-ui-text-muted border-ui-border/70 bg-ui-surface/60'"
            data-testid="fork-session-indicator"
          >
            <GitBranch :size="10" :class="forkSessionHighlight ? 'animate-pulse' : ''" aria-hidden="true" />
            <span>{{ activeForkSourceText }}</span>
          </span>
          <div v-if="hasBridge" class="w-2 h-2 bg-green-500 rounded-full shrink-0 shadow-[0_0_8px_rgba(34,197,94,0.4)]" :title="'Bridge Connected'" role="status" aria-label="Bridge Connected"></div>
        </div>

        <div class="flex items-center gap-0.5 shrink-0" role="toolbar" aria-label="会话操作">
          <button
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            title="会话历史"
            aria-label="查看会话历史列表"
            @click="listOpen = true"
          >
            <History :size="18" aria-hidden="true" />
          </button>
          
          <button
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            title="新建对话"
            aria-label="开始新对话"
            @click="handleCreateSession"
          >
            <Plus :size="20" aria-hidden="true" />
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
              <FileUp :size="18" aria-hidden="true" />
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
              class="absolute right-0 mt-1 w-32 bg-ui-bg border border-ui-border rounded-lg shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100"
              role="menu"
            >
              <button role="menuitem" @click="showDebug = true; showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
                <Bug :size="14" aria-hidden="true" /> 运行调试
              </button>
              <button role="menuitem" @click="showSettings = true; showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
                <Settings :size="14" aria-hidden="true" /> 系统设置
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
        ref="scrollContainer"
        class="flex-1 overflow-y-auto w-full min-h-0"
        role="log"
        aria-live="polite"
        aria-label="对话历史记录"
      >
        <div class="w-full px-5 pt-6 pb-8">
          <div v-if="displayMessages.length" class="space-y-8" role="list">
            <ChatMessage
              v-for="(msg, index) in displayMessages"
              :key="msg.entryId"
              :role="msg.role"
              :content="msg.content"
              :entry-id="msg.entryId"
              :tool-name="msg.toolName"
              :tool-call-id="msg.toolCallId"
              :tool-pending="msg.toolPending"
              :tool-pending-action="msg.toolPendingAction"
              :tool-pending-detail="msg.toolPendingDetail"
              :tool-pending-logs="msg.toolPendingLogs"
              :busy-placeholder="msg.busyPlaceholder"
                :busy-mode="msg.busyMode"
                :busy-source-entry-id="msg.busySourceEntryId"
                :edit-disabled="loading || isRunning"
                :copied="copiedEntryId === msg.entryId"
                :retrying="retryingEntryId === msg.entryId"
                :forking="forkingEntryId === msg.entryId || userForkingEntryId === msg.entryId"
                :show-edit-action="canEditUserMessage(msg)"
                :editing="editingUserEntryId === msg.entryId"
                :edit-draft="editingUserEntryId === msg.entryId ? editingUserDraft : ''"
                :edit-submitting="editingUserSubmitting && editingUserEntryId === msg.entryId"
                :copy-disabled="loading || !canCopyMessage(msg)"
                :retry-disabled="loading || isRunning || !canRetryMessage(msg, index)"
                :fork-disabled="loading || isRunning || !canForkMessage(msg, index)"
                :show-copy-action="canCopyMessage(msg)"
                :show-retry-action="canRetryMessage(msg, index)"
                :show-fork-action="canForkMessage(msg, index)"
                @copy="handleCopyMessage"
                @edit="handleEditMessage"
                @edit-change="handleEditDraftChange"
                @edit-cancel="handleEditCancel"
                @edit-submit="handleEditSubmit"
                @retry="handleRetryMessage"
                @fork="handleForkMessage"
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
              系统就绪。发送指令开始自动化任务。CDP 与网桥协议已建立。
            </p>
          </div>
        </div>
      </div>

      <div class="shrink-0 w-full bg-ui-bg z-20">
        <ChatInput
          v-model="prompt"
          :is-running="isRunning"
          :disabled="loading"
          @send="handleSend"
          @stop="handleStopRun"
        />
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
  </div>
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
