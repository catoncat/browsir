import {
  formatToolPendingHeadline,
  formatToolPendingStepLine,
} from "../composables/tool-run-stream-derive";
import type { ToolPendingStepState } from "./tool-formatters";

export interface RunTimelineToolItem {
  kind: "tool";
  id: string;
  step: number;
  action: string;
  detail: string;
  status: "running" | "done" | "failed";
  headline: string;
  line: string;
  logs: string[];
  createdAt: number;
}

export type RunTimelineItem = RunTimelineToolItem;

function nowMs(): number {
  return Date.now();
}

export function createRunTimelineToolItem(
  step: ToolPendingStepState,
  createdAt?: number,
): RunTimelineToolItem {
  const effectiveCreatedAt = Number(createdAt || step.step || nowMs());
  return {
    kind: "tool",
    id: `tool-${step.step}-${step.action}`,
    step: step.step,
    action: step.action,
    detail: step.detail,
    status: step.status,
    headline: formatToolPendingHeadline(step),
    line: formatToolPendingStepLine(step),
    logs: Array.isArray(step.logs) ? [...step.logs] : [],
    createdAt: effectiveCreatedAt,
  };
}

export function upsertRunTimelineToolItem(
  items: RunTimelineItem[],
  step: ToolPendingStepState,
): RunTimelineItem[] {
  const current = [...items];
  const existingIndex = current.findIndex(
    (item) => item.kind === "tool" && item.step === step.step,
  );
  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    const nextItem = createRunTimelineToolItem(
      step,
      existing.createdAt,
    );
    current[existingIndex] = nextItem;
    return current;
  }
  current.push(createRunTimelineToolItem(step));
  return current;
}

export function cloneRunTimelineItems(
  items: RunTimelineItem[],
): RunTimelineItem[] {
  return (Array.isArray(items) ? items : []).map((item) =>
    ({ ...item, logs: Array.isArray(item.logs) ? [...item.logs] : [] }),
  );
}
