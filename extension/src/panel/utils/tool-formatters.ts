import type { PanelMessageLike } from "./message-actions";

// ── Types shared with App.vue and composables ──

export interface StepStreamMeta {
  truncated: boolean;
  cutBy: "events" | "bytes" | null;
  totalEvents: number;
  totalBytes: number;
  returnedEvents: number;
  returnedBytes: number;
  maxEvents: number;
  maxBytes: number;
}

export interface ToolPendingStepState {
  step: number;
  action: string;
  detail: string;
  status: "running" | "done" | "failed";
  error?: string;
  logs: string[];
}

// ── Pure utility functions ──

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function normalizeStepStreamMeta(value: unknown): StepStreamMeta {
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

export function normalizeStep(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function normalizeEventTs(row: Record<string, unknown>): string {
  return String(row.ts || row.timestamp || new Date().toISOString());
}

export const BASH_TOOL_ACTIONS = new Set(["host_bash", "browser_bash"]);
export const FILE_TOOL_ACTIONS = new Set([
  "host_read_file",
  "browser_read_file",
  "host_write_file",
  "browser_write_file",
  "host_edit_file",
  "browser_edit_file"
]);

export function prettyToolAction(action: string): string {
  const normalized = String(action || "").trim().toLowerCase();
  const map: Record<string, string> = {
    snapshot: "读取页面快照",
    list_tabs: "检索标签页",
    open_tab: "打开标签页",
    browser_action: "执行浏览器动作",
    host_read_file: "读取主机文件",
    browser_read_file: "读取浏览器文件",
    host_write_file: "写入主机文件",
    browser_write_file: "写入浏览器文件",
    host_edit_file: "编辑主机文件",
    browser_edit_file: "编辑浏览器文件",
    host_bash: "执行主机命令",
    browser_bash: "执行浏览器命令"
  };
  return map[normalized] || (normalized ? `执行 ${normalized}` : "执行工具");
}

export function clipText(text: string, max = 96): string {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function shouldAlwaysShowToolMessage(message: PanelMessageLike): boolean {
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

export function toScalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function tryParseArgs(raw: string): Record<string, unknown> | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function formatToolPendingDetail(action: string, argsRaw: string): string {
  const normalized = String(action || "").trim().toLowerCase();
  const raw = String(argsRaw || "").trim();
  const args = tryParseArgs(raw);

  if (normalized === "list_tabs") return "正在读取当前窗口标签页信息";
  if (BASH_TOOL_ACTIONS.has(normalized)) {
    const command = toScalarText(args?.command) || raw;
    return command ? `命令：${clipText(command, 100)}` : "";
  }
  if (FILE_TOOL_ACTIONS.has(normalized)) {
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

  if (raw) return `参数：${clipText(raw, 110)}`;
  return "";
}

export function extractBashCommandFromDetail(detail: string): string {
  const text = String(detail || "").trim();
  if (!text) return "";
  if (text.startsWith("命令：")) return text.slice(3).trim();
  return text;
}

export function extractPathHintFromCommand(command: string): string {
  const raw = String(command || "").trim();
  if (!raw) return "";
  const quoted = raw.match(/["'](\/[^"']+)["']/);
  if (quoted?.[1]) return quoted[1];
  const plain = raw.match(/(\/[^\s|;&]+)/);
  return plain?.[1] || "";
}

export function inferBashIntent(command: string): string {
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

export function summarizeToolPendingStep(item: ToolPendingStepState): { label: string; detail: string } {
  const normalizedAction = String(item.action || "").trim().toLowerCase();
  const compactDetail = String(item.detail || "")
    .replace(/^命令：/u, "")
    .replace(/^路径：/u, "")
    .replace(/^目标：/u, "")
    .trim();

  if (!BASH_TOOL_ACTIONS.has(normalizedAction)) {
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
