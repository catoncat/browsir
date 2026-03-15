import type { StepTraceRecord, ToolRunSnapshot } from "../types";
import {
  clipText,
  formatToolPendingDetail,
  normalizeEventTs,
  normalizeStep,
  summarizeToolPendingStep,
  toRecord,
  type ToolPendingStepState,
} from "../utils/tool-formatters";

const LOOP_TERMINAL_TYPES = new Set([
  "loop_done",
  "loop_error",
  "loop_skip_stopped",
  "loop_internal_error",
]);

export function deriveActiveToolRunFromStream(
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

export function deriveCurrentLoopWindow(stream: StepTraceRecord[]) {
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

export function deriveToolPendingStepStatesFromStream(
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

export function formatToolPendingStepLine(item: ToolPendingStepState): string {
  const icon =
    item.status === "running" ? "…" : item.status === "done" ? "✓" : "✗";
  const summary = summarizeToolPendingStep(item);
  const base = `${icon} #${item.step} ${summary.label}${summary.detail ? ` · ${summary.detail}` : ""}`;
  if (item.status !== "failed") return base;
  const errorText = String(item.error || "").trim();
  return errorText ? `${base} · ${clipText(errorText, 96)}` : base;
}

export function formatToolPendingHeadline(item: ToolPendingStepState): string {
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
