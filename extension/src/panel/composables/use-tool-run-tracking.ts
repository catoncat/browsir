import { computed, ref, type ComputedRef, type Ref, type WritableComputedRef } from "vue";
import type {
  RunViewPhase,
  RunViewState,
  RuntimeProgressHint,
  RuntimeResponse,
  StepTraceRecord,
  ToolRunSnapshot,
} from "../types";
import type { LlmStreamEventResult } from "./use-llm-streaming";
import {
  clipText,
  formatToolPendingDetail,
  normalizeEventTs,
  normalizeStep,
  normalizeStepStreamMeta,
  prettyToolAction,
  summarizeToolPendingStep,
  toRecord,
  type ToolPendingStepState,
} from "../utils/tool-formatters";

const TOOL_STREAM_SYNC_MAX_EVENTS = 5000;
const TOOL_STREAM_SYNC_MAX_BYTES = 4 * 1024 * 1024;
const TOOL_STEP_MAX_LINES = 24;
const TOOL_STEP_LOG_MAX_LINES = 24;
const TOOL_STEP_LOG_FLUSH_MS = 72;
const TOOL_CARD_HANDOFF_MS = 180;
const TOOL_INITIAL_SYNC_INTERVAL_MS = 180;
const TOOL_INITIAL_SYNC_MAX_ATTEMPTS = 18;
const LOOP_TERMINAL_TYPES = new Set([
  "loop_done",
  "loop_error",
  "loop_skip_stopped",
  "loop_internal_error",
]);

export interface ToolRunTrackingDeps {
  activeSessionId: Ref<string>;
  isRunActive: ComputedRef<boolean>;
  runSafely: (task: () => Promise<void>, fallback: string) => Promise<void>;
  applyStreamEvent: (
    type: string,
    payload: Record<string, unknown>,
    eventSessionId: string,
  ) => LlmStreamEventResult;
  resetLlmStreamingState: () => void;
}

export function useToolRunTracking(deps: ToolRunTrackingDeps) {
  const activeRunHint = ref<RuntimeProgressHint | null>(null);
  const runViewState = ref<RunViewState>({
    phase: "idle",
    epoch: 0,
    activeToolRun: null,
    toolPendingStepStates: [],
  });
  const activeRunToken = ref(0);

  let pendingStepLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let toolPendingCardLeaveTimer: ReturnType<typeof setTimeout> | null = null;
  let initialToolSyncTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingStepLogBuffer = new Map<number, string[]>();

  function patchRunViewState(patch: Partial<RunViewState>) {
    runViewState.value = {
      ...runViewState.value,
      ...patch,
    };
  }

  function bumpRunViewEpoch(phase: RunViewPhase) {
    runViewState.value = {
      phase,
      epoch: runViewState.value.epoch + 1,
      activeToolRun: null,
      toolPendingStepStates: [],
    };
  }

  const runPhase = computed<RunViewPhase>({
    get: () => runViewState.value.phase,
    set: (value) => {
      if (value === runViewState.value.phase) return;
      patchRunViewState({ phase: value });
    },
  });

  const activeToolRun = computed<ToolRunSnapshot | null>({
    get: () => runViewState.value.activeToolRun,
    set: (value) => {
      patchRunViewState({ activeToolRun: value });
    },
  });

  const toolPendingStepStates = computed<ToolPendingStepState[]>({
    get: () => runViewState.value.toolPendingStepStates,
    set: (value) => {
      patchRunViewState({
        toolPendingStepStates: Array.isArray(value) ? value : [],
      });
    },
  });

  const finalAssistantStreamingPhase = computed({
    get: () => runPhase.value === "final_assistant",
    set: (value: boolean) => {
      if (value) {
        runPhase.value = "final_assistant";
        return;
      }
      if (runPhase.value !== "final_assistant") return;
      runPhase.value = deps.isRunActive.value ? "llm" : "idle";
    },
  });

  const toolPendingCardLeaving = computed(
    () => runPhase.value === "tool_handoff_leaving",
  );

  function setLlmRunHint(label: string, detail = "") {
    activeRunHint.value = {
      phase: "llm",
      label: String(label || "").trim() || "思考中",
      detail: String(detail || "").trim(),
      ts: new Date().toISOString(),
    };
  }

  function setToolRunHint(action: string, argsRaw: string, ts: string) {
    activeRunHint.value = {
      phase: "tool",
      label: prettyToolAction(action),
      detail: formatToolPendingDetail(action, argsRaw),
      ts: String(ts || new Date().toISOString()),
    };
  }

  function clearRunHint() {
    activeRunHint.value = null;
  }

  function clearBoundLlmStreamingState() {
    deps.resetLlmStreamingState();
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
      runPhase.value = deps.isRunActive.value ? "final_assistant" : "idle";
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
      if (!deps.isRunActive.value) return;
      const sessionId = String(deps.activeSessionId.value || "").trim();
      if (!sessionId) return;
      const hasStableActivity =
        Boolean(activeToolRun.value) ||
        toolPendingStepStates.value.length > 0 ||
        runPhase.value === "final_assistant" ||
        runPhase.value === "tool_handoff_leaving";
      if (hasStableActivity) return;
      attempts += 1;
      void deps.runSafely(
        () => syncActiveToolRun(sessionId),
        "同步工具运行状态失败",
      );
      if (attempts >= TOOL_INITIAL_SYNC_MAX_ATTEMPTS) return;
      initialToolSyncTimer = setTimeout(tick, TOOL_INITIAL_SYNC_INTERVAL_MS);
    };
    initialToolSyncTimer = setTimeout(tick, TOOL_INITIAL_SYNC_INTERVAL_MS);
  }

  function resolveToolPendingLogStep(list: ToolPendingStepState[]): number {
    if (!list.length) return 0;
    const activeStep = Number(activeToolRun.value?.step || 0);
    if (activeStep > 0) {
      for (let i = 0; i < list.length; i += 1) {
        if (list[i]?.step === activeStep) {
          return activeStep;
        }
      }
    }
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (item?.status === "running") {
        return item.step;
      }
    }
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
      const merged = [
        ...(Array.isArray(list[idx].logs) ? list[idx].logs : []),
        ...buffered,
      ];
      if (merged.length > TOOL_STEP_LOG_MAX_LINES) {
        merged.splice(0, merged.length - TOOL_STEP_LOG_MAX_LINES);
      }
      list[idx] = {
        ...list[idx],
        logs: merged,
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

    const normalized = parts.map((line) =>
      stream === "stderr" ? `stderr | ${line}` : line,
    );
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
    const errorText = String(input.error || "").trim();

    const list = [...toolPendingStepStates.value];
    const index = list.findIndex((item) => item.step === step);
    const next: ToolPendingStepState = {
      step,
      action,
      detail,
      status: input.status,
      error: errorText,
      logs: index >= 0 && Array.isArray(list[index]?.logs) ? list[index].logs : [],
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
    const icon =
      item.status === "running" ? "…" : item.status === "done" ? "✓" : "✗";
    const summary = summarizeToolPendingStep(item);
    const base = `${icon} #${item.step} ${summary.label}${summary.detail ? ` · ${summary.detail}` : ""}`;
    if (item.status !== "failed") return base;
    const errorText = String(item.error || "").trim();
    return errorText ? `${base} · ${clipText(errorText, 96)}` : base;
  }

  function formatToolPendingHeadline(item: ToolPendingStepState): string {
    const summary = summarizeToolPendingStep(item);
    const statusText =
      item.status === "running"
        ? "进行中"
        : item.status === "done"
          ? "已完成"
          : "失败";
    const base = `${statusText} · #${item.step} ${summary.label}`;
    if (item.status !== "failed") return base;
    const errorText = String(item.error || "").trim();
    return errorText ? `${base} · ${clipText(errorText, 64)}` : base;
  }

  function deriveActiveToolRunFromStream(
    stream: StepTraceRecord[],
  ): ToolRunSnapshot | null {
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
          ts: normalizeEventTs(toRecord(row)),
        });
        continue;
      }
      if (type === "step_finished" && mode === "tool_call") {
        const step = normalizeStep(payload.step);
        if (!step) continue;
        pendingByStep.delete(step);
        continue;
      }
      if (LOOP_TERMINAL_TYPES.has(type)) {
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

    const inProgress =
      lastLoopStartIndex >= 0 && lastLoopStartIndex > lastLoopTerminalIndex;
    if (lastLoopStartIndex >= 0) {
      return {
        inProgress,
        stream: list.slice(lastLoopStartIndex),
      };
    }
    if (lastLoopTerminalIndex >= 0) {
      return {
        inProgress: false,
        stream: list.slice(lastLoopTerminalIndex + 1),
      };
    }
    return {
      inProgress: false,
      stream: list,
    };
  }

  function deriveToolPendingStepStatesFromStream(
    stream: StepTraceRecord[],
  ): ToolPendingStepState[] {
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
        String(previous?.detail || "").trim() ||
        formatToolPendingDetail(action, String(payload.arguments || ""));

      if (type === "step_planned") {
        byStep.set(step, {
          step,
          action,
          detail,
          status: "running",
          error: "",
          logs: previous?.logs || [],
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
          logs: previous?.logs || [],
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
    const responseSource = String(payload.source || "").trim();

    if (type === "loop_start") {
      activeRunToken.value += 1;
      bumpRunViewEpoch("llm");
      clearToolPendingCardLeaveTimer();
      clearBoundLlmStreamingState();
      finalAssistantStreamingPhase.value = false;
      setLlmRunHint("分析任务", "正在规划下一步动作");
      return;
    }
    if (type === "llm.request") {
      if (String(payload.mode || "").trim().toLowerCase() === "compaction") {
        if (runPhase.value === "idle") {
          runPhase.value = "llm";
        }
        setLlmRunHint("整理上下文", "正在压缩历史上下文");
        return;
      }
      if (runPhase.value === "idle") {
        runPhase.value = "llm";
      }
      if (responseSource === "hosted_chat_transport") {
        setLlmRunHint("宿主生成中", "正在通过网页会话规划下一步");
        return;
      }
      setLlmRunHint("调用模型", "正在生成下一步计划");
      return;
    }
    // ── Delegate LLM streaming events to use-llm-streaming ───────
    const streamResult = deps.applyStreamEvent(type, payload, eventSessionId);
    if (streamResult.handled) {
      if (streamResult.finalAssistant === true) {
        finalAssistantStreamingPhase.value = true;
      } else if (streamResult.finalAssistant === false) {
        finalAssistantStreamingPhase.value = false;
      }
      if (streamResult.runPhase) {
        const target = streamResult.runPhase;
        if (target === "llm" && runPhase.value !== "tool_running" && runPhase.value !== "tool_handoff_leaving") {
          runPhase.value = "llm";
        } else if (target !== "llm") {
          runPhase.value = target;
        }
      }
      if (streamResult.hint) {
        setLlmRunHint(streamResult.hint.label, streamResult.hint.detail);
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
      const detail = formatToolPendingDetail(
        action,
        String(payload.arguments || ""),
      );
      upsertToolPendingStepState({
        step,
        action,
        detail,
        status: "running",
        logs: [],
      });
      activeToolRun.value = {
        step,
        action,
        arguments: String(payload.arguments || ""),
        ts,
      };
      setToolRunHint(action, String(payload.arguments || ""), ts);
      return;
    }
    if (type === "step_finished" && mode === "tool_call") {
      flushBufferedToolPendingLogs();
      const step = normalizeStep(payload.step);
      if (!step) return;
      const existing =
        toolPendingStepStates.value.find((item) => item.step === step) || null;
      const action = String(payload.action || existing?.action || "");
      const detail =
        existing?.detail ||
        formatToolPendingDetail(action, String(payload.arguments || ""));
      const ok = payload.ok === true;
      const errorText = String(payload.error || "").trim();
      upsertToolPendingStepState({
        step,
        action,
        detail,
        status: ok ? "done" : "failed",
        error: errorText,
        logs: existing?.logs || [],
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
      deps.resetLlmStreamingState();
      return;
    }
    if (type === "auto_compaction_start") {
      if (runPhase.value === "idle") {
        runPhase.value = "llm";
      }
      setLlmRunHint("整理上下文", "正在压缩历史上下文");
      return;
    }
    if (type === "auto_compaction_end") {
      if (String(payload.errorMessage || "").trim()) {
        setLlmRunHint("继续推理", "上下文压缩失败，继续执行");
      } else {
        setLlmRunHint("继续推理", "上下文压缩完成，继续执行");
      }
      return;
    }
    if (LOOP_TERMINAL_TYPES.has(type)) {
      activeToolRun.value = null;
      clearBoundLlmStreamingState();
      clearToolPendingCardLeaveTimer();
      finalAssistantStreamingPhase.value = false;
      runPhase.value = "idle";
      clearToolPendingSteps();
      clearRunHint();
    }
  }

  function applyBridgeEventToolOutput(rawEvent: unknown) {
    const envelope = toRecord(rawEvent);
    const eventSessionId = String(envelope.sessionId || "").trim();
    if (!eventSessionId || eventSessionId !== String(deps.activeSessionId.value || "").trim()) {
      return;
    }
    if (!deps.isRunActive.value) return;
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
      maxBytes: TOOL_STREAM_SYNC_MAX_BYTES,
    })) as RuntimeResponse<{
      stream?: StepTraceRecord[];
      streamMeta?: unknown;
    }>;
    if (!response?.ok) {
      throw new Error(String(response?.error || "读取 step stream 失败"));
    }
    const stream = Array.isArray(response?.data?.stream)
      ? response.data?.stream || []
      : [];
    const meta = normalizeStepStreamMeta(response?.data?.streamMeta);
    const currentLoop = deriveCurrentLoopWindow(stream);
    const hasLoopStartEvent = stream.some(
      (item) => String(item?.type || "") === "loop_start",
    );
    const shouldHoldStateForTruncatedWindow = Boolean(
      deps.isRunActive.value && meta.truncated && !hasLoopStartEvent,
    );
    if (!currentLoop.inProgress) {
      if (shouldHoldStateForTruncatedWindow) {
        if (!activeRunHint.value || activeRunHint.value.phase !== "tool") {
          setLlmRunHint("恢复中", "事件窗口已裁剪，等待增量事件同步");
        }
        return;
      }
      if (!deps.isRunActive.value) {
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
        if (rowType === "llm.stream.start" || rowType === "llm.stream.delta") {
          return true;
        }
        if (rowType !== "llm.response.parsed") return false;
        const data = toRecord(row?.payload);
        const toolCalls = Number(data.toolCalls || 0);
        return !(Number.isFinite(toolCalls) && toolCalls > 0);
      });
      runPhase.value = sawFinal ? "final_assistant" : "llm";
    }
    if (latest) {
      setToolRunHint(latest.action, latest.arguments, latest.ts);
    } else if (deps.isRunActive.value && !activeRunHint.value) {
      setLlmRunHint("思考中", "正在分析你的请求");
    }
  }

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

  const primaryToolPendingStepState = computed(
    () => runningToolPendingStepState.value || latestToolPendingStepState.value,
  );

  const hasRunningToolPendingActivity = computed(
    () =>
      Boolean(activeToolRun.value) ||
      toolPendingStepStates.value.some((item) => item.status === "running"),
  );

  const hasToolPendingActivity = computed(
    () =>
      Boolean(activeToolRun.value) || toolPendingStepStates.value.length > 0,
  );

  const toolPendingCardStatus = computed<"running" | "done" | "failed">(() => {
    if (hasRunningToolPendingActivity.value) return "running";
    if (deps.isRunActive.value && hasToolPendingActivity.value) return "running";
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
        detail: formatToolPendingDetail(
          activeToolRun.value.action,
          activeToolRun.value.arguments,
        ),
        status: "running" as const,
        error: "",
        logs: [],
      };
      return formatToolPendingHeadline(pending);
    }
    if (deps.isRunActive.value && hasToolPendingActivity.value) {
      return "进行中 · 正在处理步骤结果";
    }
    if (latestToolPendingStepState.value) {
      return formatToolPendingHeadline(latestToolPendingStepState.value);
    }
    return "等待工具步骤";
  });

  const shouldShowToolPendingCard = computed(() => {
    if (!deps.isRunActive.value) return false;
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
      return formatToolPendingDetail(
        activeToolRun.value.action,
        activeToolRun.value.arguments,
      );
    }
    return String(primaryToolPendingStepState.value?.detail || "").trim();
  });

  const toolPendingCardStepsData = computed(() => {
    const active = activeToolRun.value;
    const fallback =
      runningToolPendingStepState.value || latestToolPendingStepState.value;
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
        logs: [],
      });
      return [
        {
          step: active.step,
          status: "running" as const,
          line,
          logs: [],
        },
      ];
    }

    if (!source) return [];
    return [
      {
        step: source.step,
        status: source.status,
        line: formatToolPendingStepLine(source),
        logs: Array.isArray(source.logs)
          ? source.logs.slice(-TOOL_STEP_LOG_MAX_LINES)
          : [],
      },
    ];
  });

  function cleanup() {
    stopInitialToolSync();
    clearToolPendingCardLeaveTimer();
    clearActiveToolRun();
    clearToolPendingSteps();
    clearRunHint();
  }

  return {
    runPhase: runPhase as WritableComputedRef<RunViewPhase>,
    activeToolRun,
    activeRunHint,
    toolPendingStepStates,
    activeRunToken,
    finalAssistantStreamingPhase,
    toolPendingCardLeaving,
    hasRunningToolPendingActivity,
    hasToolPendingActivity,
    toolPendingCardStatus,
    toolPendingCardHeadline,
    shouldShowToolPendingCard,
    toolPendingCardAction,
    toolPendingCardDetail,
    toolPendingCardStepsData,
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
    cleanup,
  };
}
