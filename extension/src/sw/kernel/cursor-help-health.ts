import type { CursorHelpSenderInspect } from "../../shared/cursor-help-protocol";
import type { CursorHelpSlotRecord } from "./cursor-help-pool-policy";

export interface CursorHelpInspectResult extends CursorHelpSenderInspect {
  url: string;
  selectedModel?: string;
  availableModels?: string[];
  canBootExecute?: boolean;
}

export function canCursorHelpSlotBootExecute(
  inspect: CursorHelpInspectResult | null,
): boolean {
  return Boolean(
    inspect &&
      inspect.pageHookReady &&
      inspect.fetchHookReady &&
      !inspect.runtimeMismatch,
  );
}

export function formatInspectFailure(inspect: CursorHelpInspectResult | null): string {
  if (!inspect) return "页面尚未准备好，请稍后重试。";
  if (!inspect.pageHookReady) return "页面尚未准备好，请稍后重试。";
  if (!inspect.fetchHookReady) return "请求通道尚未准备好，请稍后重试。";
  if (inspect.runtimeMismatch) return "页面环境需要刷新后重试。";
  if (!inspect.senderReady) return "输入入口尚未准备好，请稍后重试。";
  return "当前页面暂时无法执行，请稍后重试。";
}

export function classifyInspectHealth(
  inspect: CursorHelpInspectResult | null,
): Pick<CursorHelpSlotRecord, "status" | "lastHealthReason" | "lastError"> {
  if (!inspect) {
    return {
      status: "stale",
      lastHealthReason: "inspect-failed",
      lastError: "页面尚未准备好，请稍后重试。",
    };
  }
  if (inspect.runtimeMismatch) {
    return {
      status: "error",
      lastHealthReason: "runtime-mismatch",
      lastError: formatInspectFailure(inspect),
    };
  }
  if (!canCursorHelpSlotBootExecute(inspect)) {
    return {
      status: "warming",
      lastHealthReason: "page-not-ready",
      lastError: formatInspectFailure(inspect),
    };
  }
  return {
    status: "idle",
    lastHealthReason: "ready",
    lastError: "",
  };
}

export function buildSlotHealthSnapshot(
  status: CursorHelpSlotRecord["status"],
  reason: string,
  error = "",
): Pick<CursorHelpSlotRecord, "status" | "lastHealthCheckedAt" | "lastHealthReason" | "lastError"> {
  return {
    status,
    lastHealthCheckedAt: Date.now(),
    lastHealthReason: String(reason || "").trim() || undefined,
    lastError: String(error || "").trim() || undefined,
  };
}

export function getRecoveryBudget(reason: string): number {
  const normalized = String(reason || "").trim();
  if (normalized === "page-not-ready") return 3;
  if (normalized === "inspect-failed") return 2;
  if (normalized === "tab-missing") return 2;
  return 1;
}
