<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from "vue";
import { useRuntimeStore } from "./stores/runtime";
import { useMessageActions, type PanelMessageLike, type PendingRegenerateState } from "./utils/message-actions";
import { collectDiagnostics } from "./utils/diagnostics";

import SessionList from "./components/SessionList.vue";
import ChatMessage from "./components/ChatMessage.vue";
import StreamingDraftContainer from "./components/StreamingDraftContainer.vue";
import ChatInput from "./components/ChatInput.vue";
import SettingsView from "./components/SettingsView.vue";
import DebugView from "./components/DebugView.vue";
import { Loader2, Plus, Settings, Bug, Activity, History, MoreVertical, FileText, Download, ExternalLink, Copy, GitBranch, RefreshCcw } from "lucide-vue-next";
import { onClickOutside } from "@vueuse/core";

const store = useRuntimeStore();
const { loading, error, sessions, activeSessionId, messages, runtime, isRegeneratingTitle } = storeToRefs(store);

const prompt = ref("");
const scrollContainer = ref<HTMLElement | null>(null);
const listOpen = ref(false);
const showSettings = ref(false);
const showDebug = ref(false);
const showMoreMenu = ref(false);
const showExportMenu = ref(false);
const showToolHistory = ref(true);
const creatingSession = ref(false);
const moreMenuRef = ref(null);
const exportMenuRef = ref(null);
let createSessionTask: Promise<void> | null = null;
const bridgeConnectionStatus = ref<"unknown" | "connected" | "disconnected">("unknown");
const forkSourceResolvedTitle = ref("");

onClickOutside(moreMenuRef, () => showMoreMenu.value = false);
onClickOutside(exportMenuRef, () => showExportMenu.value = false);

const isRunning = computed(() => Boolean(runtime.value?.running && !runtime.value?.stopped));
const runtimeQueueState = computed(() => ({
  steer: Number(runtime.value?.queue?.steer || 0),
  followUp: Number(runtime.value?.queue?.followUp || 0),
  total: Number(runtime.value?.queue?.total || 0)
}));
const showBridgeOfflineDot = computed(() => bridgeConnectionStatus.value === "disconnected");
const activeSession = computed(() => sessions.value.find((item) => item.id === activeSessionId.value) || null);

const activeSessionTitle = computed(() => {
  const session = activeSession.value;
  return session?.title || "新对话";
});

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

interface DisplayMessage extends PanelMessageLike {
  role: string;
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
  toolPending?: boolean;
  toolPendingLeaving?: boolean;
  toolPendingStatus?: "running" | "done" | "failed";
  toolPendingHeadline?: string;
  toolPendingAction?: string;
  toolPendingDetail?: string;
  toolPendingSteps?: string[];
  toolPendingStepsData?: Array<{
    step: number;
    status: "running" | "done" | "failed";
    line: string;
    logs: string[];
  }>;
}

interface StepTraceRecord {
  type?: string;
  timestamp?: string;
  ts?: string;
  payload?: Record<string, unknown>;
}

interface StepStreamMeta {
  truncated: boolean;
  cutBy: "events" | "bytes" | null;
  totalEvents: number;
  totalBytes: number;
  returnedEvents: number;
  returnedBytes: number;
  maxEvents: number;
  maxBytes: number;
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

interface ToolPendingStepState {
  step: number;
  action: string;
  detail: string;
  status: "running" | "done" | "failed";
  error?: string;
  logs: string[];
}

type RunViewPhase = "idle" | "llm" | "tool_running" | "tool_handoff_leaving" | "final_assistant";

interface RunViewState {
  phase: RunViewPhase;
  epoch: number;
  activeToolRun: ToolRunSnapshot | null;
  toolPendingStepStates: ToolPendingStepState[];
}

interface RuntimeEventDigest {
  source: "brain" | "bridge";
  ts: string;
  type: string;
  preview: string;
  sessionId: string;
}

async function regenerateFromAssistantWithScene(
  entryId: string,
  options: { mode?: "fork" | "retry"; setActive?: boolean } = {}
) {
  const startedAt = Date.now();
  const result = await store.regenerateFromAssistantEntry(entryId, {
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
  isRunning,
  regenerateFromAssistantEntry: regenerateFromAssistantWithScene
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
const activeRunHint = ref<RuntimeProgressHint | null>(null);
const runViewState = ref<RunViewState>({
  phase: "idle",
  epoch: 0,
  activeToolRun: null,
  toolPendingStepStates: []
});
const llmStreamingText = ref("");
const llmStreamingSessionId = ref("");
const llmStreamingActive = ref(false);
const recentRuntimeEvents = ref<RuntimeEventDigest[]>([]);
let forkSessionHighlightTimer: ReturnType<typeof setTimeout> | null = null;
let pendingStepLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
let toolPendingCardLeaveTimer: ReturnType<typeof setTimeout> | null = null;
let initialToolSyncTimer: ReturnType<typeof setTimeout> | null = null;
let llmStreamFlushRaf: number | null = null;
let llmStreamingDeltaBuffer = "";
const pendingStepLogBuffer = new Map<number, string[]>();

const USER_FORK_MIN_VISIBLE_MS = 620;
const USER_FORK_SCENE_PREPARE_MS = 140;
const USER_FORK_SCENE_LEAVE_MS = 170;
const USER_FORK_SCENE_ENTER_MS = 240;
const FORK_SWITCH_HIGHLIGHT_MS = 1800;
const TOOL_STREAM_SYNC_INTERVAL_MS = 3200;
const TOOL_STREAM_SYNC_MAX_EVENTS = 5000;
const TOOL_STREAM_SYNC_MAX_BYTES = 4 * 1024 * 1024;
const TOOL_STEP_MAX_LINES = 24;
const TOOL_STEP_LOG_MAX_LINES = 24;
const TOOL_STEP_LOG_FLUSH_MS = 72;
const TOOL_CARD_HANDOFF_MS = 180;
const TOOL_INITIAL_SYNC_INTERVAL_MS = 180;
const TOOL_INITIAL_SYNC_MAX_ATTEMPTS = 18;
const MAIN_SCROLL_BOTTOM_THRESHOLD_PX = 120;
const RUNTIME_EVENT_MAX = 220;
const LOOP_TERMINAL_TYPES = new Set([
  "loop_done",
  "loop_error",
  "loop_skip_stopped",
  "loop_internal_error"
]);

function patchRunViewState(patch: Partial<RunViewState>) {
  runViewState.value = {
    ...runViewState.value,
    ...patch
  };
}

function bumpRunViewEpoch(phase: RunViewPhase) {
  runViewState.value = {
    phase,
    epoch: runViewState.value.epoch + 1,
    activeToolRun: null,
    toolPendingStepStates: []
  };
}

const runPhase = computed<RunViewPhase>({
  get: () => runViewState.value.phase,
  set: (value) => {
    if (value === runViewState.value.phase) return;
    patchRunViewState({ phase: value });
  }
});

const activeToolRun = computed<ToolRunSnapshot | null>({
  get: () => runViewState.value.activeToolRun,
  set: (value) => {
    patchRunViewState({ activeToolRun: value });
  }
});

const toolPendingStepStates = computed<ToolPendingStepState[]>({
  get: () => runViewState.value.toolPendingStepStates,
  set: (value) => {
    patchRunViewState({ toolPendingStepStates: Array.isArray(value) ? value : [] });
  }
});

const activeRunToken = ref(0);

const toolPendingCardLeaving = computed(() => runPhase.value === "tool_handoff_leaving");

const finalAssistantStreamingPhase = computed({
  get: () => runPhase.value === "final_assistant",
  set: (value: boolean) => {
    if (value) {
      runPhase.value = "final_assistant";
      return;
    }
    if (runPhase.value !== "final_assistant") return;
    runPhase.value = isRunning.value ? "llm" : "idle";
  }
});

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

async function switchForkSessionWithScene(
  targetSessionId: string,
  options: { startedAt?: number } = {}
) {
  const normalizedTargetSessionId = String(targetSessionId || "").trim();
  if (!normalizedTargetSessionId) return;

  const startedAt = Number.isFinite(Number(options.startedAt)) ? Number(options.startedAt) : Date.now();
  const elapsed = Date.now() - startedAt;
  if (elapsed < USER_FORK_MIN_VISIBLE_MS) {
    await sleep(USER_FORK_MIN_VISIBLE_MS - elapsed);
  }
  await playForkSceneSwitch(normalizedTargetSessionId);
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

function normalizeStepStreamMeta(value: unknown): StepStreamMeta {
  const row = toRecord(value);
  const normalizeInt = (raw: unknown) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  };
  const cutByRaw = String(row.cutBy || "").trim().toLowerCase();
  const cutBy: "events" | "bytes" | null = cutByRaw === "events" || cutByRaw === "bytes"
    ? (cutByRaw as "events" | "bytes")
    : null;

  return {
    truncated: row.truncated === true,
    cutBy,
    totalEvents: normalizeInt(row.totalEvents),
    totalBytes: normalizeInt(row.totalBytes),
    returnedEvents: normalizeInt(row.returnedEvents),
    returnedBytes: normalizeInt(row.returnedBytes),
    maxEvents: normalizeInt(row.maxEvents),
    maxBytes: normalizeInt(row.maxBytes)
  };
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

function shouldAlwaysShowToolMessage(message: PanelMessageLike): boolean {
  if (String(message?.role || "") !== "tool") return false;
  const content = String(message?.content || "").trim();
  if (!content) return false;
  try {
    const parsed = JSON.parse(content);
    const row = toRecord(parsed);
    if (typeof row.error === "string" && String(row.error).trim()) return true;
    if (row.ok === false) return true;
    const response = toRecord(row.response);
    const bridgeResult = toRecord(response.response);
    if (bridgeResult.ok === false) return true;
    return false;
  } catch {
    return /error|failed|失败|异常/i.test(content);
  }
}

function pushRecentRuntimeEvent(source: "brain" | "bridge", event: unknown) {
  const row = toRecord(event);
  const payload = toRecord(row.payload || row.data);
  const type = String(row.type || row.event || "").trim() || "unknown";
  const ts = String(row.ts || row.timestamp || new Date().toISOString());
  const sessionId = String(row.sessionId || "").trim();
  const preview = clipText(
    String(payload.error || payload.message || payload.action || payload.arguments || payload.reason || payload.chunk || ""),
    180
  );
  const merged = [
    ...recentRuntimeEvents.value,
    { source, ts, type, preview, sessionId }
  ];
  if (merged.length > RUNTIME_EVENT_MAX) {
    merged.splice(0, merged.length - RUNTIME_EVENT_MAX);
  }
  recentRuntimeEvents.value = merged;
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

function extractBashCommandFromDetail(detail: string): string {
  const text = String(detail || "").trim();
  if (!text) return "";
  if (text.startsWith("命令：")) return text.slice(3).trim();
  return text;
}

function extractPathHintFromCommand(command: string): string {
  const raw = String(command || "").trim();
  if (!raw) return "";
  const quoted = raw.match(/["'](\/[^"']+)["']/);
  if (quoted?.[1]) return quoted[1];
  const plain = raw.match(/(\/[^\s|;&]+)/);
  return plain?.[1] || "";
}

function inferBashIntent(command: string): string {
  const text = String(command || "").toLowerCase();
  if (!text) return "执行命令";
  if (/^\s*uname\b/.test(text)) return "识别系统";
  if (/\becho\s+\$home\b/.test(text)) return "读取主目录";
  if (/^\s*pwd\b/.test(text)) return "查看当前目录";
  if (/\btest\s+-d\b/.test(text)) return "校验目录";
  if (/\bls\b/.test(text)) return "查看目录";
  if (/\bcat\b/.test(text)) return "读取文件";
  if (/\bfind\b|\brg\b|\bgrep\b/.test(text)) return "搜索文件";
  if (/\bmkdir\b/.test(text)) return "创建目录";
  if (/\bcp\b|\bmv\b/.test(text)) return "整理文件";
  if (/\bpnpm\b|\bnpm\b|\bbun\b|\byarn\b/.test(text)) return "执行脚本";
  return "执行命令";
}

function summarizeToolPendingStep(item: ToolPendingStepState): { label: string; detail: string } {
  const normalizedAction = String(item.action || "").trim().toLowerCase();
  const compactDetail = String(item.detail || "")
    .replace(/^命令：/u, "")
    .replace(/^路径：/u, "")
    .replace(/^目标：/u, "")
    .trim();

  if (normalizedAction !== "bash") {
    return {
      label: prettyToolAction(item.action),
      detail: compactDetail
    };
  }

  const command = extractBashCommandFromDetail(item.detail);
  const intent = inferBashIntent(command);
  const pathHint = extractPathHintFromCommand(command);
  if (pathHint && ["查看目录", "读取文件", "校验目录", "搜索文件"].includes(intent)) {
    return {
      label: intent,
      detail: clipText(pathHint, 64)
    };
  }
  if (["识别系统", "读取主目录", "查看当前目录"].includes(intent)) {
    return {
      label: intent,
      detail: ""
    };
  }
  return {
    label: intent,
    detail: command ? clipText(command, 72) : compactDetail
  };
}

function clearActiveToolRun() {
  activeToolRun.value = null;
}

function clearToolPendingSteps() {
  toolPendingStepStates.value = [];
  pendingStepLogBuffer.clear();
  if (pendingStepLogFlushTimer) {
    clearTimeout(pendingStepLogFlushTimer);
    pendingStepLogFlushTimer = null;
  }
}

function clearToolPendingCardLeaveTimer() {
  if (toolPendingCardLeaveTimer) {
    clearTimeout(toolPendingCardLeaveTimer);
    toolPendingCardLeaveTimer = null;
  }
}

function resetToolPendingCardHandoff() {
  clearToolPendingCardLeaveTimer();
  if (runPhase.value === "tool_handoff_leaving") {
    runPhase.value = "tool_running";
  }
}

function dismissToolPendingCardWithHandoff() {
  if (runPhase.value !== "tool_running") return;
  const epoch = runViewState.value.epoch;
  runPhase.value = "tool_handoff_leaving";
  clearToolPendingCardLeaveTimer();
  toolPendingCardLeaveTimer = setTimeout(() => {
    toolPendingCardLeaveTimer = null;
    if (epoch !== runViewState.value.epoch) return;
    if (runPhase.value !== "tool_handoff_leaving") return;
    runPhase.value = isRunning.value ? "final_assistant" : "idle";
  }, TOOL_CARD_HANDOFF_MS);
}

function stopInitialToolSync() {
  if (initialToolSyncTimer) {
    clearTimeout(initialToolSyncTimer);
    initialToolSyncTimer = null;
  }
}

function startInitialToolSync() {
  stopInitialToolSync();
  let attempts = 0;
  const tick = () => {
    if (!isRunning.value) return;
    const sessionId = String(activeSessionId.value || "").trim();
    if (!sessionId) return;
    const hasStableActivity =
      Boolean(activeToolRun.value) ||
      toolPendingStepStates.value.length > 0 ||
      runPhase.value === "final_assistant" ||
      runPhase.value === "tool_handoff_leaving";
    if (hasStableActivity) return;
    attempts += 1;
    void runSafely(() => syncActiveToolRun(sessionId), "同步工具运行状态失败");
    if (attempts >= TOOL_INITIAL_SYNC_MAX_ATTEMPTS) return;
    initialToolSyncTimer = setTimeout(tick, TOOL_INITIAL_SYNC_INTERVAL_MS);
  };
  initialToolSyncTimer = setTimeout(tick, TOOL_INITIAL_SYNC_INTERVAL_MS);
}

function flushLlmStreamingDeltaBuffer() {
  if (!llmStreamingDeltaBuffer) return;
  llmStreamingText.value = `${llmStreamingText.value}${llmStreamingDeltaBuffer}`;
  llmStreamingDeltaBuffer = "";
}

function scheduleLlmStreamingFlush() {
  if (llmStreamFlushRaf != null) return;
  llmStreamFlushRaf = requestAnimationFrame(() => {
    llmStreamFlushRaf = null;
    flushLlmStreamingDeltaBuffer();
  });
}

function appendLlmStreamingDelta(chunk: string) {
  const text = String(chunk || "");
  if (!text) return;
  llmStreamingDeltaBuffer += text;
  scheduleLlmStreamingFlush();
}

function resetLlmStreamingState() {
  if (llmStreamFlushRaf != null) {
    cancelAnimationFrame(llmStreamFlushRaf);
    llmStreamFlushRaf = null;
  }
  llmStreamingDeltaBuffer = "";
  llmStreamingText.value = "";
  llmStreamingSessionId.value = "";
  llmStreamingActive.value = false;
  finalAssistantStreamingPhase.value = false;
}

function resolveToolPendingLogStep(list: ToolPendingStepState[]): number {
  if (!list.length) return 0;
  const activeStep = Number(activeToolRun.value?.step || 0);
  if (activeStep > 0 && list.some((item) => item.step === activeStep)) return activeStep;
  const running = list.findLast((item) => item.status === "running");
  if (running) return running.step;
  return Number(list[list.length - 1]?.step || 0);
}

function flushBufferedToolPendingLogs() {
  if (pendingStepLogBuffer.size === 0) return;
  const list = [...toolPendingStepStates.value];
  let changed = false;

  for (const [step, buffered] of pendingStepLogBuffer.entries()) {
    if (!Array.isArray(buffered) || buffered.length === 0) continue;
    const idx = list.findIndex((item) => item.step === step);
    if (idx < 0 || !list[idx]) continue;
    const merged = [...(Array.isArray(list[idx].logs) ? list[idx].logs : []), ...buffered];
    if (merged.length > TOOL_STEP_LOG_MAX_LINES) {
      merged.splice(0, merged.length - TOOL_STEP_LOG_MAX_LINES);
    }
    list[idx] = {
      ...list[idx],
      logs: merged
    };
    changed = true;
  }

  pendingStepLogBuffer.clear();
  if (changed) {
    toolPendingStepStates.value = list;
  }
}

function scheduleFlushBufferedToolPendingLogs() {
  if (pendingStepLogFlushTimer) return;
  pendingStepLogFlushTimer = setTimeout(() => {
    pendingStepLogFlushTimer = null;
    flushBufferedToolPendingLogs();
  }, TOOL_STEP_LOG_FLUSH_MS);
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
  const list = [...toolPendingStepStates.value];
  if (!list.length) return;

  const step = resolveToolPendingLogStep(list);
  if (!step) return;
  const buffered = pendingStepLogBuffer.get(step) || [];
  buffered.push(...normalized);
  pendingStepLogBuffer.set(step, buffered);
  scheduleFlushBufferedToolPendingLogs();
}

function upsertToolPendingStepState(input: ToolPendingStepState) {
  const step = normalizeStep(input.step);
  if (!step) return;
  const action = String(input.action || "").trim();
  if (!action) return;
  const detail = String(input.detail || "").trim();
  const error = String(input.error || "").trim();

  const list = [...toolPendingStepStates.value];
  const index = list.findIndex((item) => item.step === step);
  const next: ToolPendingStepState = {
    step,
    action,
    detail,
    status: input.status,
    error,
    logs: index >= 0 && Array.isArray(list[index]?.logs) ? list[index].logs : []
  };
  if (index >= 0) {
    list[index] = next;
  } else {
    list.push(next);
  }
  if (list.length > TOOL_STEP_MAX_LINES) {
    list.splice(0, list.length - TOOL_STEP_MAX_LINES);
  }
  toolPendingStepStates.value = list;
}

function formatToolPendingStepLine(item: ToolPendingStepState): string {
  const icon = item.status === "running" ? "…" : item.status === "done" ? "✓" : "✗";
  const summary = summarizeToolPendingStep(item);
  const base = `${icon} #${item.step} ${summary.label}${summary.detail ? ` · ${summary.detail}` : ""}`;
  if (item.status !== "failed") return base;
  const errorText = String(item.error || "").trim();
  return errorText ? `${base} · ${clipText(errorText, 96)}` : base;
}

function formatToolPendingHeadline(item: ToolPendingStepState): string {
  const summary = summarizeToolPendingStep(item);
  const statusText = item.status === "running" ? "进行中" : item.status === "done" ? "已完成" : "失败";
  const base = `${statusText} · #${item.step} ${summary.label}`;
  if (item.status !== "failed") return base;
  const errorText = String(item.error || "").trim();
  return errorText ? `${base} · ${clipText(errorText, 64)}` : base;
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

function deriveCurrentLoopWindow(stream: StepTraceRecord[]) {
  const list = Array.isArray(stream) ? stream : [];
  let lastLoopStartIndex = -1;
  let lastLoopTerminalIndex = -1;

  for (let i = 0; i < list.length; i += 1) {
    const type = String(list[i]?.type || "");
    if (type === "loop_start") {
      lastLoopStartIndex = i;
      continue;
    }
    if (LOOP_TERMINAL_TYPES.has(type)) {
      lastLoopTerminalIndex = i;
    }
  }

  const inProgress = lastLoopStartIndex >= 0 && lastLoopStartIndex > lastLoopTerminalIndex;
  if (lastLoopStartIndex >= 0) {
    return {
      inProgress,
      stream: list.slice(lastLoopStartIndex)
    };
  }
  if (lastLoopTerminalIndex >= 0) {
    return {
      inProgress: false,
      stream: list.slice(lastLoopTerminalIndex + 1)
    };
  }
  return {
    inProgress: false,
    stream: list
  };
}

function deriveToolPendingStepStatesFromStream(stream: StepTraceRecord[]): ToolPendingStepState[] {
  const byStep = new Map<number, ToolPendingStepState>();
  for (const row of stream || []) {
    const type = String(row?.type || "");
    const payload = toRecord(row?.payload);
    const mode = String(payload.mode || "");
    if (mode !== "tool_call") continue;
    const step = normalizeStep(payload.step);
    if (!step) continue;

    const previous = byStep.get(step) || null;
    const action = String(payload.action || previous?.action || "");
    const detail =
      String(previous?.detail || "").trim() || formatToolPendingDetail(action, String(payload.arguments || ""));

    if (type === "step_planned") {
      byStep.set(step, {
        step,
        action,
        detail,
        status: "running",
        error: "",
        logs: previous?.logs || []
      });
      continue;
    }

    if (type === "step_finished") {
      byStep.set(step, {
        step,
        action,
        detail,
        status: payload.ok === true ? "done" : "failed",
        error: String(payload.error || "").trim(),
        logs: previous?.logs || []
      });
    }
  }

  return Array.from(byStep.values()).sort((a, b) => a.step - b.step);
}

function applyRuntimeEventToolRun(event: unknown) {
  const envelope = toRecord(event);
  const type = String(envelope.type || "");
  const payload = toRecord(envelope.payload);
  const mode = String(payload.mode || "");
  const ts = normalizeEventTs(envelope);
  const eventSessionId = String(envelope.sessionId || "").trim();
  if (type === "loop_start") {
    activeRunToken.value += 1;
    bumpRunViewEpoch("llm");
    clearToolPendingCardLeaveTimer();
    resetLlmStreamingState();
    setLlmRunHint("分析任务", "正在规划下一步动作");
    return;
  }
  if (type === "llm.request") {
    if (String(payload.mode || "").trim().toLowerCase() === "compaction") {
      return;
    }
    if (runPhase.value === "idle") {
      runPhase.value = "llm";
    }
    setLlmRunHint("调用模型", "正在生成下一步计划");
    return;
  }
  if (type === "llm.stream.start") {
    flushLlmStreamingDeltaBuffer();
    if (String(llmStreamingText.value || "").trim()) {
      const tail = llmStreamingText.value.endsWith("\n") ? "" : "\n";
      llmStreamingText.value = `${llmStreamingText.value}${tail}`;
    }
    llmStreamingSessionId.value = eventSessionId || String(activeSessionId.value || "");
    llmStreamingActive.value = true;
    if (runPhase.value !== "tool_running" && runPhase.value !== "tool_handoff_leaving") {
      runPhase.value = "final_assistant";
    }
    setLlmRunHint("回答中", "正在生成回复");
    return;
  }
  if (type === "llm.stream.delta") {
    const chunk = String(payload.text || "");
    if (!chunk) return;
    const activeId = String(activeSessionId.value || "").trim();
    const sourceId = llmStreamingSessionId.value || eventSessionId;
    if (sourceId && activeId && sourceId !== activeId) return;
    llmStreamingSessionId.value = sourceId || activeId;
    appendLlmStreamingDelta(chunk);
    llmStreamingActive.value = true;
    return;
  }
  if (type === "llm.stream.end") {
    flushLlmStreamingDeltaBuffer();
    llmStreamingActive.value = false;
    return;
  }
  if (type === "llm.response.parsed") {
    const toolCalls = Number(payload.toolCalls || 0);
    if (Number.isFinite(toolCalls) && toolCalls > 0) {
      flushLlmStreamingDeltaBuffer();
      llmStreamingText.value = "";
      llmStreamingActive.value = false;
      finalAssistantStreamingPhase.value = false;
      if (runPhase.value !== "tool_running") {
        runPhase.value = "llm";
      }
    } else {
      finalAssistantStreamingPhase.value = true;
      setLlmRunHint("整理回复", "正在生成最终回答");
    }
    return;
  }
  if (type === "step_planned" && mode === "tool_call") {
    const step = normalizeStep(payload.step);
    if (!step) return;
    finalAssistantStreamingPhase.value = false;
    runPhase.value = "tool_running";
    resetToolPendingCardHandoff();
    const action = String(payload.action || "");
    const detail = formatToolPendingDetail(action, String(payload.arguments || ""));
    upsertToolPendingStepState({
      step,
      action,
      detail,
      status: "running"
    });
    activeToolRun.value = {
      step,
      action,
      arguments: String(payload.arguments || ""),
      ts
    };
    setToolRunHint(action, String(payload.arguments || ""), ts);
    return;
  }
  if (type === "step_finished" && mode === "tool_call") {
    flushBufferedToolPendingLogs();
    const step = normalizeStep(payload.step);
    if (!step) return;
    const existing = toolPendingStepStates.value.find((item) => item.step === step) || null;
    const action = String(payload.action || existing?.action || "");
    const detail = existing?.detail || formatToolPendingDetail(action, String(payload.arguments || ""));
    const ok = payload.ok === true;
    const errorText = String(payload.error || "").trim();
    upsertToolPendingStepState({
      step,
      action,
      detail,
      status: ok ? "done" : "failed",
      error: errorText
    });
    if (activeToolRun.value && activeToolRun.value.step === step) {
      activeToolRun.value = null;
    }
    if (!activeToolRun.value) {
      runPhase.value = "llm";
    }
    setLlmRunHint("继续推理", "正在处理工具结果");
    return;
  }
  if (type === "step_finished" && mode === "llm") {
    flushLlmStreamingDeltaBuffer();
    llmStreamingActive.value = false;
    return;
  }
  if (["loop_done", "loop_error", "loop_skip_stopped", "loop_internal_error"].includes(type)) {
    activeToolRun.value = null;
    resetLlmStreamingState();
    clearToolPendingCardLeaveTimer();
    runPhase.value = "idle";
    clearToolPendingSteps();
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

  if (eventName === "invoke.stdout") {
    appendToolPendingLogs("stdout", String(data.chunk || ""));
    return;
  }
  if (eventName === "invoke.stderr") {
    appendToolPendingLogs("stderr", String(data.chunk || ""));
    return;
  }
  if (eventName === "invoke.finished") return;
}

async function syncActiveToolRun(sessionId: string) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return;
  const response = (await chrome.runtime.sendMessage({
    type: "brain.step.stream",
    sessionId: normalizedSessionId,
    maxEvents: TOOL_STREAM_SYNC_MAX_EVENTS,
    maxBytes: TOOL_STREAM_SYNC_MAX_BYTES
  })) as { ok?: boolean; data?: { stream?: StepTraceRecord[]; streamMeta?: unknown }; error?: string };
  if (!response?.ok) {
    throw new Error(String(response?.error || "读取 step stream 失败"));
  }
  const stream = Array.isArray(response?.data?.stream) ? response.data?.stream || [] : [];
  const meta = normalizeStepStreamMeta(response?.data?.streamMeta);
  const currentLoop = deriveCurrentLoopWindow(stream);
  const hasLoopStartEvent = stream.some((item) => String(item?.type || "") === "loop_start");
  const shouldHoldStateForTruncatedWindow = Boolean(
    isRunning.value &&
    meta.truncated &&
    !hasLoopStartEvent
  );
  if (!currentLoop.inProgress) {
    if (shouldHoldStateForTruncatedWindow) {
      if (!activeRunHint.value || activeRunHint.value.phase !== "tool") {
        setLlmRunHint("恢复中", "事件窗口已裁剪，等待增量事件同步");
      }
      return;
    }
    if (!isRunning.value) {
      runPhase.value = "idle";
    } else if (runPhase.value !== "final_assistant") {
      runPhase.value = "llm";
    }
    clearActiveToolRun();
    clearToolPendingSteps();
    return;
  }
  if (toolPendingStepStates.value.length === 0 && currentLoop.inProgress) {
    const recovered = deriveToolPendingStepStatesFromStream(currentLoop.stream);
    if (recovered.length > 0) {
      toolPendingStepStates.value = recovered;
    }
  }
  const latest = deriveActiveToolRunFromStream(currentLoop.stream);
  activeToolRun.value = latest;
  if (
    latest ||
    toolPendingStepStates.value.some((item) => item.status === "running")
  ) {
    runPhase.value = "tool_running";
  } else {
    const sawFinal = currentLoop.stream.some((row) => {
      const rowType = String(row?.type || "");
      if (rowType === "llm.stream.start" || rowType === "llm.stream.delta") return true;
      if (rowType !== "llm.response.parsed") return false;
      const data = toRecord(row?.payload);
      const toolCalls = Number(data.toolCalls || 0);
      return !(Number.isFinite(toolCalls) && toolCalls > 0);
    });
    runPhase.value = sawFinal ? "final_assistant" : "llm";
  }
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
  return null;
});

const latestToolPendingStepState = computed(() => {
  const list = toolPendingStepStates.value;
  return list.length > 0 ? list[list.length - 1] : null;
});

const runningToolPendingStepState = computed(() => {
  const list = toolPendingStepStates.value;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.status === "running") return list[i];
  }
  return null;
});

const primaryToolPendingStepState = computed(() =>
  runningToolPendingStepState.value || latestToolPendingStepState.value
);

const hasRunningToolPendingActivity = computed(() =>
  Boolean(activeToolRun.value) || toolPendingStepStates.value.some((item) => item.status === "running")
);

const toolPendingCardStatus = computed<"running" | "done" | "failed">(() => {
  if (hasRunningToolPendingActivity.value) return "running";
  if (isRunning.value && hasToolPendingActivity.value) return "running";
  if (latestToolPendingStepState.value?.status === "failed") return "failed";
  if (latestToolPendingStepState.value?.status === "done") return "done";
  return activeToolRun.value ? "running" : "done";
});

const toolPendingCardHeadline = computed(() => {
  if (runningToolPendingStepState.value) {
    return formatToolPendingHeadline(runningToolPendingStepState.value);
  }
  if (activeToolRun.value) {
    const pending = {
      step: activeToolRun.value.step,
      action: activeToolRun.value.action,
      detail: formatToolPendingDetail(activeToolRun.value.action, activeToolRun.value.arguments),
      status: "running" as const,
      error: "",
      logs: []
    };
    return formatToolPendingHeadline(pending);
  }
  if (isRunning.value && hasToolPendingActivity.value) {
    return "进行中 · 正在处理步骤结果";
  }
  if (latestToolPendingStepState.value) {
    return formatToolPendingHeadline(latestToolPendingStepState.value);
  }
  return "等待工具步骤";
});

const hasToolPendingActivity = computed(() =>
  Boolean(activeToolRun.value) || toolPendingStepStates.value.length > 0
);

const shouldShowStreamingDraft = computed(() => {
  if (!isRunning.value) return false;

  const sourceSessionId = String(llmStreamingSessionId.value || "").trim();
  const currentSessionId = String(activeSessionId.value || "").trim();
  if (sourceSessionId && currentSessionId && sourceSessionId !== currentSessionId) {
    return false;
  }

  const text = String(llmStreamingText.value || "");
  const normalizedText = text.trim();

  if (llmStreamingActive.value) {
    if (runPhase.value === "tool_running" || runPhase.value === "tool_handoff_leaving") {
      return normalizedText.length > 0;
    }
    return true;
  }

  if (!normalizedText) {
    return false;
  }

  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    const item = messages.value[i];
    if (String(item?.role || "") !== "assistant") continue;
    const content = String(item?.content || "").trim();
    if (!content) continue;
    if (content === normalizedText) return false;
    break;
  }

  return true;
});

const shouldShowToolPendingCard = computed(() => {
  if (!isRunning.value) return false;
  if (runPhase.value !== "tool_running") return false;
  return Boolean(activeToolRun.value || runningToolPendingStepState.value);
});

const toolPendingCardAction = computed(() => {
  if (activeToolRun.value) return prettyToolAction(activeToolRun.value.action);
  if (primaryToolPendingStepState.value?.action) {
    return prettyToolAction(primaryToolPendingStepState.value.action);
  }
  return "工具调用步骤";
});

const toolPendingCardDetail = computed(() => {
  if (activeToolRun.value) {
    return formatToolPendingDetail(activeToolRun.value.action, activeToolRun.value.arguments);
  }
  return String(primaryToolPendingStepState.value?.detail || "").trim();
});

const toolPendingCardStepsData = computed(() => {
  const active = activeToolRun.value;
  const fallback = runningToolPendingStepState.value || latestToolPendingStepState.value;
  const fromState = active
    ? toolPendingStepStates.value.find((item) => item.step === active.step) || null
    : null;
  const source = fromState || fallback;

  if (!source && !active) return [];

  if (!source && active) {
    const line = formatToolPendingStepLine({
      step: active.step,
      action: active.action,
      detail: formatToolPendingDetail(active.action, active.arguments),
      status: "running",
      error: "",
      logs: []
    });
    return [{
      step: active.step,
      status: "running" as const,
      line,
      logs: []
    }];
  }

  if (!source) return [];
  return [{
    step: source.step,
    status: source.status,
    line: formatToolPendingStepLine(source),
    logs: Array.isArray(source.logs) ? source.logs.slice(-TOOL_STEP_LOG_MAX_LINES) : []
  }];
});

const toolHistoryToggleLabel = computed(() =>
  showToolHistory.value ? "隐藏工具轨迹" : "显示工具轨迹"
);

const stableMessages = computed<DisplayMessage[]>(() => {
  return (messages.value || [])
    .filter((item) => {
      const role = String(item?.role || "");
      if (role !== "tool") return true;
      if (showToolHistory.value) return true;
      return shouldAlwaysShowToolMessage(item);
    })
    .map((item) => ({
      role: String(item?.role || ""),
      content: String(item?.content || ""),
      entryId: String(item?.entryId || ""),
      toolName: String(item?.toolName || ""),
      toolCallId: String(item?.toolCallId || "")
    }));
});

const hasVisibleConversation = computed(() =>
  stableMessages.value.length > 0 || shouldShowStreamingDraft.value || shouldShowToolPendingCard.value
);

watch(isRunning, (running, wasRunning) => {
  if (running) {
    if (runPhase.value === "idle") {
      runPhase.value = "llm";
    }
    resetToolPendingCardHandoff();
    if (!wasRunning) {
      activeRunToken.value += 1;
      clearToolPendingSteps();
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
    startInitialToolSync();
    return;
  }
  stopInitialToolSync();
  resetToolPendingCardHandoff();
  userPendingRegenerate.value = null;
  runPhase.value = "idle";
  clearActiveToolRun();
  clearToolPendingSteps();
  resetLlmStreamingState();
  activeRunHint.value = null;
});

watch(activeSessionId, () => {
  stopInitialToolSync();
  resetToolPendingCardHandoff();
  runPhase.value = isRunning.value ? "llm" : "idle";
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
  clearToolPendingSteps();
  resetLlmStreamingState();
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
    startInitialToolSync();
  }
});

watch(
  [
    isRunning,
    hasToolPendingActivity,
    hasRunningToolPendingActivity,
    llmStreamingActive,
    llmStreamingText,
    finalAssistantStreamingPhase
  ],
  ([running, hasActivity, hasRunningTool, streamingActive, streamingText, finalPhase]) => {
    if (!running || !hasActivity) return;
    if (hasRunningTool) {
      resetToolPendingCardHandoff();
      stopInitialToolSync();
      return;
    }
    if (!finalPhase) return;
    const hasStreaming = streamingActive || Boolean(String(streamingText || "").trim());
    if (hasStreaming) {
      dismissToolPendingCardWithHandoff();
    }
  }
);

watch(
  [() => pendingRegenerate.value, () => userPendingRegenerate.value],
  ([assistantPending, userPending]) => {
    if (!assistantPending && !userPending) return;
    resetToolPendingCardHandoff();
    clearActiveToolRun();
    clearToolPendingSteps();
    finalAssistantStreamingPhase.value = false;
    runPhase.value = "llm";
    if (isRunning.value) {
      startInitialToolSync();
    }
  }
);

watch(
  messages,
  (list) => {
    if (!editingUserEntryId.value) return;
    const exists = list.some((item) => String(item?.entryId || "") === editingUserEntryId.value);
    if (!exists) resetEditingState();
  },
  { deep: true }
);

watch(
  [activeForkSourceSessionId, activeForkSourceSession],
  async ([sourceId, sourceSession]) => {
    const id = String(sourceId || "").trim();
    if (!id) {
      forkSourceResolvedTitle.value = "";
      return;
    }

    const titleInList = String((sourceSession as { title?: string } | null)?.title || "").trim();
    if (titleInList) {
      forkSourceResolvedTitle.value = "";
      return;
    }

    try {
      const response = (await chrome.runtime.sendMessage({
        type: "brain.session.get",
        sessionId: id
      })) as { ok?: boolean; data?: Record<string, unknown> };
      if (response?.ok !== true) return;
      const meta = toRecord(response.data?.meta);
      const header = toRecord(meta.header);
      const title = String(header.title || "").trim();
      forkSourceResolvedTitle.value = title;
    } catch {
      // 忽略来源标题查询失败，继续使用兜底文案。
    }
  },
  { immediate: true }
);

function isMainScrollNearBottom() {
  const el = scrollContainer.value;
  if (!el) return true;
  const remain = el.scrollHeight - el.scrollTop - el.clientHeight;
  return remain <= MAIN_SCROLL_BOTTOM_THRESHOLD_PX;
}

const visibleMessageStructureKey = computed(() =>
  [
    stableMessages.value.map((item) => `${item.role}:${item.entryId}`).join("|"),
    shouldShowStreamingDraft.value
      ? `draft:${String(activeSessionId.value || "__global__")}:${activeRunToken.value}`
      : "",
    shouldShowToolPendingCard.value
      ? `tool:${String(activeSessionId.value || "__global__")}:${activeRunToken.value}`
      : ""
  ].join("|")
);

watch(visibleMessageStructureKey, async () => {
  const shouldFollow = isMainScrollNearBottom();
  await nextTick();
  if (shouldFollow && scrollContainer.value) {
    scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
  }
});

watch(llmStreamingText, async () => {
  if (!isRunning.value) return;
  const shouldFollow = isMainScrollNearBottom();
  await nextTick();
  if (shouldFollow && scrollContainer.value) {
    scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
  }
});

watch(
  () =>
    toolPendingStepStates.value
      .map((item) => `${item.step}:${item.status}:${item.logs.length}`)
      .join("|"),
  async () => {
    if (!isRunning.value) return;
    const shouldFollow = isMainScrollNearBottom();
    await nextTick();
    if (shouldFollow && scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
    }
  }
);

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
      await switchForkSessionWithScene(result.sessionId, { startedAt });
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

async function refreshBridgeConnectionStatus() {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "bridge.connect",
      force: false
    })) as { ok?: boolean };
    bridgeConnectionStatus.value = response?.ok ? "connected" : "disconnected";
  } catch {
    bridgeConnectionStatus.value = "disconnected";
  }
}

const onRuntimeMessage = (message: unknown) => {
  const payload = message as {
    type?: string;
    status?: string;
    event?: { sessionId?: string };
    payload?: { sessionId?: string; event?: string; data?: Record<string, unknown> };
  };

  if (payload?.type === "bridge.status") {
    const status = String(payload.status || "").trim();
    bridgeConnectionStatus.value = status === "connected" ? "connected" : "disconnected";
    return;
  }

  if (payload?.type === "bridge.event") {
    bridgeConnectionStatus.value = "connected";
    if (payload.payload) {
      pushRecentRuntimeEvent("bridge", payload.payload);
    }
    applyBridgeEventToolOutput(payload.payload);
    return;
  }

  if (payload?.type !== "brain.event") return;
  if (payload.event) {
    pushRecentRuntimeEvent("brain", payload.event);
  }
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
    await refreshBridgeConnectionStatus();
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

useIntervalFn(() => {
  void refreshBridgeConnectionStatus();
}, 6000);

async function handleCreateSession() {
  if (createSessionTask) {
    await createSessionTask;
    return;
  }
  creatingSession.value = true;
  createSessionTask = runSafely(async () => {
    await store.createSession();
    listOpen.value = false;
  }, "新建会话失败").finally(() => {
    creatingSession.value = false;
    createSessionTask = null;
  });
  await createSessionTask;
}

async function handleSelectSession(id: string) {
  await runSafely(async () => {
    await store.loadConversation(id, { setActive: true });
    listOpen.value = false;
  }, "切换会话失败");
}

async function handleJumpToForkSourceSession() {
  const sourceId = activeForkSourceSessionId.value;
  if (!sourceId) return;
  await runSafely(async () => {
    if (!sessions.value.some((item) => item.id === sourceId)) {
      await store.refreshSessions();
    }
    await playForkSceneSwitch(sourceId);
  }, "跳转分叉来源失败");
}

async function handleDeleteSession(id: string) {
  await runSafely(() => store.deleteSession(id), "删除会话失败");
}

async function handleUpdateSessionTitle(id: string, title: string) {
  await runSafely(() => store.updateSessionTitle(id, title), "重命名失败");
}

async function handleRefreshSession(id: string) {
  await runSafely(() => store.refreshSessionTitle(id), "刷新标题失败");
}

async function handleStopRun() {
  await runSafely(() => store.runAction("brain.run.stop"), "停止任务失败");
}

async function handleSend(payload: { text: string; tabIds: number[]; mode: "normal" | "steer" | "followUp" }) {
  if (createSessionTask) {
    await createSessionTask;
  }
  const text = String(payload.text || "");
  if (!text.trim()) return;
  const isNew = !activeSessionId.value;

  try {
    await store.sendPrompt(text, {
      newSession: isNew,
      tabIds: Array.isArray(payload.tabIds) ? payload.tabIds : [],
      streamingBehavior: payload.mode === "normal" ? undefined : payload.mode
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

async function handleCopyDiagnostics() {
  try {
    const sessionId = String(activeSessionId.value || "").trim();
    const { text } = await collectDiagnostics({
      sessionId: sessionId || undefined,
      recentEvents: recentRuntimeEvents.value.map((item) => ({
        source: item.source,
        ts: item.ts,
        type: item.type,
        preview: item.preview,
        sessionId: item.sessionId
      })),
      timelineLimit: 28
    });
    await navigator.clipboard.writeText(text);
    actionNotice.value = { type: "success", message: "诊断信息已复制" };
    setTimeout(() => {
      actionNotice.value = null;
    }, 2200);
  } catch (err) {
    setErrorMessage(err, "复制诊断信息失败");
  }
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
  stopInitialToolSync();
  clearToolPendingCardLeaveTimer();
  if (forkSessionHighlightTimer) {
    clearTimeout(forkSessionHighlightTimer);
    forkSessionHighlightTimer = null;
  }
  bumpForkSceneToken();
  resetForkSceneState();
  clearActiveToolRun();
  clearToolPendingSteps();
  resetLlmStreamingState();
  recentRuntimeEvents.value = [];
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
      @update-title="handleUpdateSessionTitle"
    />

    <SettingsView v-if="showSettings" @close="showSettings = false" />
    <DebugView v-if="showDebug" @close="showDebug = false" />

    <main
      class="relative flex-1 flex flex-col min-w-0 min-h-0 bg-ui-bg"
      :aria-busy="isForkSceneActive ? 'true' : undefined"
    >
      <div v-if="loading && !hasVisibleConversation" class="absolute inset-0 z-40 flex items-center justify-center bg-white/80">
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
            <h1 v-if="!isRegeneratingTitle" class="min-w-0 text-[15px] font-bold text-ui-text truncate tracking-tight">
              {{ activeSessionTitle }}
            </h1>
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
            @click="listOpen = true"
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
              <button role="menuitem" @click="handleCopyDiagnostics(); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
                <Copy :size="14" aria-hidden="true" /> 复制诊断信息
              </button>
              <button role="menuitem" @click="handleRefreshSession(activeSessionId); showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
                <RefreshCcw :size="14" aria-hidden="true" /> 重新生成标题
              </button>
              <button role="menuitem" @click="showToolHistory = !showToolHistory; showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
                <Activity :size="14" aria-hidden="true" /> {{ toolHistoryToggleLabel }}
              </button>
              <button role="menuitem" @click="showDebug = true; showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none border-t border-ui-border/30">
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
          <div v-if="hasVisibleConversation" class="space-y-2" role="list">
            <ChatMessage
              v-for="(msg, index) in stableMessages"
              :key="msg.entryId"
              :role="msg.role"
              :content="msg.content"
              :entry-id="msg.entryId"
              :tool-name="msg.toolName"
              :tool-call-id="msg.toolCallId"
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

            <StreamingDraftContainer
              v-if="shouldShowStreamingDraft"
              :content="llmStreamingText"
              :active="llmStreamingActive"
            />

            <ChatMessage
              v-if="shouldShowToolPendingCard"
              :key="`__tool_pending__${String(activeSessionId || '__global__')}__${activeRunToken}`"
              role="tool_pending"
              content=""
              :entry-id="`__tool_pending__${String(activeSessionId || '__global__')}__${activeRunToken}`"
              :tool-name="activeToolRun?.action || toolPendingCardAction || 'llm'"
              :tool-pending="true"
              :tool-pending-leaving="toolPendingCardLeaving"
              :tool-pending-status="toolPendingCardStatus"
              :tool-pending-headline="toolPendingCardHeadline"
              :tool-pending-action="toolPendingCardAction"
              :tool-pending-detail="toolPendingCardDetail"
              :tool-pending-steps-data="toolPendingCardStepsData"
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
          :queue-state="runtimeQueueState"
          :disabled="loading || creatingSession"
          @send="handleSend"
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
