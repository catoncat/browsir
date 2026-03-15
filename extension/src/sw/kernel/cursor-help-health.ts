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
  if (!inspect) return "未找到可用的 Cursor Help 页面。请确认页面已完成加载。";
  if (!inspect.pageHookReady) return "Cursor Help 页面 hook 未就绪，请稍后重试。";
  if (!inspect.fetchHookReady) return "Cursor Help 请求接管未就绪，请稍后重试。";
  if (inspect.runtimeMismatch) {
    const suffix = inspect.runtimeMismatchReason ? ` ${inspect.runtimeMismatchReason}` : "";
    return `Cursor Help 运行时版本不一致。${suffix}`.trim();
  }
  if (!inspect.senderReady) {
    const suffix = inspect.lastSenderError ? ` ${inspect.lastSenderError}` : "";
    return `Cursor Help 内部入口未就绪。${suffix}`.trim();
  }
  return "Cursor Help 页面暂不可执行正式链路。";
}

export function classifyInspectHealth(
  inspect: CursorHelpInspectResult | null,
): Pick<CursorHelpSlotRecord, "status" | "lastHealthReason" | "lastError"> {
  if (!inspect) {
    return {
      status: "stale",
      lastHealthReason: "inspect-failed",
      lastError: "未找到可用的 Cursor Help 页面。请确认页面已完成加载。",
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
