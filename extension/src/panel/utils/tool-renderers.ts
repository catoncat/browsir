type JsonRecord = Record<string, unknown>;

export type ToolRenderTone = "neutral" | "success" | "error";
export type ToolRenderKind = "snapshot" | "tabs" | "invoke" | "browser" | "default";

export interface ToolRenderResult {
  kind: ToolRenderKind;
  tone: ToolRenderTone;
  title: string;
  subtitle: string;
  detail: string;
}

interface ResolveToolRenderInput {
  content: string;
  toolName?: string;
  toolCallId?: string;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toText(value: unknown): string {
  return String(value || "").trim();
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeParseJson(raw: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, value: raw };
  }
}

function formatDetail(raw: string, payload: unknown, parsed: boolean): string {
  if (!parsed) return raw || "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return raw || "";
  }
}

function shortHost(url: string): string {
  const value = toText(url);
  if (!value) return "";
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function inferToolName(inputToolName: string, payload: JsonRecord): string {
  if (inputToolName) return inputToolName;
  if (toText(payload.tool)) return toText(payload.tool).toLowerCase();
  if (Array.isArray(payload.tabs)) return "list_tabs";
  if (payload.opened === true || (payload.tab && typeof payload.tab === "object")) return "open_tab";
  if (Array.isArray(payload.nodes) || toText(payload.snapshotId) || toText(payload.compact)) return "snapshot";
  if (toText(payload.verifyReason) || typeof payload.verified === "boolean") return "browser_action";
  if (toText(payload.type) === "invoke" || (payload.response && typeof payload.response === "object")) return "invoke";
  return "";
}

function renderToolTarget(toolName: string, payload: JsonRecord): string {
  const fromPayload = toText(payload.target);
  if (fromPayload) return fromPayload;
  const args = asRecord(payload.args);
  const normalized = String(toolName || "").trim().toLowerCase();

  if (normalized === "bash") {
    const command = toText(args.command) || toText(payload.rawArgs);
    return command ? `命令：${command}` : "";
  }
  if (["read_file", "write_file", "edit_file"].includes(normalized)) {
    const path = toText(args.path);
    return path ? `路径：${path}` : "";
  }
  if (normalized === "open_tab") {
    const url = toText(args.url);
    return url ? `目标：${url}` : "";
  }
  if (normalized === "snapshot") {
    const mode = toText(args.mode) || "interactive";
    const selector = toText(args.selector);
    return selector ? `模式：${mode} · 选择器：${selector}` : `模式：${mode}`;
  }
  if (normalized === "browser_action") {
    const kind = toText(args.kind);
    const target = toText(args.url) || toText(args.ref) || toText(args.selector);
    if (kind && target) return `${kind} · ${target}`;
    return kind ? `动作：${kind}` : "";
  }
  return "";
}

function renderSnapshot(payload: JsonRecord, detail: string): ToolRenderResult {
  const error = toText(payload.error);
  if (error) {
    return {
      kind: "snapshot",
      tone: "error",
      title: "页面读取失败",
      subtitle: error,
      detail
    };
  }
  const title = toText(payload.title);
  const url = toText(payload.url);
  const host = shortHost(url);
  const count = toNumber(payload.count);
  const subtitleParts = [host, count > 0 ? `${count} 个节点` : ""].filter(Boolean);
  return {
    kind: "snapshot",
    tone: "success",
    title: title ? `已读取页面：${title}` : "已读取页面快照",
    subtitle: subtitleParts.join(" · "),
    detail
  };
}

function renderListTabs(payload: JsonRecord, detail: string): ToolRenderResult {
  const countFromPayload = toNumber(payload.count);
  const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
  const count = countFromPayload > 0 ? countFromPayload : tabs.length;
  const first = asRecord(tabs[0]);
  const firstTitle = toText(first.title);
  return {
    kind: "tabs",
    tone: "success",
    title: `已获取 ${count} 个标签页`,
    subtitle: firstTitle ? `示例：${firstTitle}` : "",
    detail
  };
}

function renderOpenTab(payload: JsonRecord, detail: string): ToolRenderResult {
  const error = toText(payload.error);
  if (error) {
    return {
      kind: "tabs",
      tone: "error",
      title: "打开标签页失败",
      subtitle: error,
      detail
    };
  }
  const tab = asRecord(payload.tab);
  const title = toText(tab.title);
  const url = toText(tab.url);
  return {
    kind: "tabs",
    tone: "success",
    title: "已打开标签页",
    subtitle: title || url || "",
    detail
  };
}

function renderInvoke(toolName: string, callId: string, payload: JsonRecord, detail: string): ToolRenderResult {
  const error = toText(payload.error);
  if (error) {
    const target = renderToolTarget(toolName, payload);
    return {
      kind: "invoke",
      tone: "error",
      title: `工具调用失败：${toolName || "invoke"}`,
      subtitle: [target, error].filter(Boolean).join(" · "),
      detail
    };
  }

  const bridgeResponse = asRecord(payload.response);
  const invokeResult = asRecord(bridgeResponse.response);
  const bridgeTool = toText(asRecord(invokeResult.data).echoedTool);
  const toolLabel = toolName || bridgeTool || "invoke";
  const invokeId = toText(invokeResult.id) || callId;
  const target = renderToolTarget(toolLabel, payload);

  return {
    kind: "invoke",
    tone: "success",
    title: `已执行工具：${toolLabel}`,
    subtitle: [target, invokeId ? `调用 ID: ${invokeId}` : ""].filter(Boolean).join(" · "),
    detail
  };
}

function renderBrowser(payload: JsonRecord, detail: string): ToolRenderResult {
  const error = toText(payload.error);
  if (error) {
    return {
      kind: "browser",
      tone: "error",
      title: "浏览器动作失败",
      subtitle: error,
      detail
    };
  }
  const verified = payload.verified === true;
  const verifyReason = toText(payload.verifyReason);
  return {
    kind: "browser",
    tone: verified ? "success" : "neutral",
    title: verified ? "浏览器动作已执行并通过验证" : "浏览器动作已执行",
    subtitle: verifyReason,
    detail
  };
}

function renderDefault(toolName: string, callId: string, payload: JsonRecord, detail: string): ToolRenderResult {
  const error = toText(payload.error);
  if (error) {
    const target = renderToolTarget(toolName, payload);
    return {
      kind: "default",
      tone: "error",
      title: `工具失败：${toolName || "unknown"}`,
      subtitle: [target, error].filter(Boolean).join(" · "),
      detail
    };
  }
  return {
    kind: "default",
    tone: "neutral",
    title: toolName ? `已执行工具：${toolName}` : "已执行工具调用",
    subtitle: [renderToolTarget(toolName, payload), callId ? `调用 ID: ${callId}` : ""].filter(Boolean).join(" · "),
    detail
  };
}

export function resolveToolRender(input: ResolveToolRenderInput): ToolRenderResult {
  const content = String(input.content || "");
  const callId = toText(input.toolCallId);
  const parsed = safeParseJson(content);
  const payload = asRecord(parsed.value);
  const toolName = inferToolName(toText(input.toolName).toLowerCase(), payload);
  const detail = formatDetail(content, payload, parsed.ok);

  if (toolName === "snapshot") return renderSnapshot(payload, detail);
  if (toolName === "list_tabs") return renderListTabs(payload, detail);
  if (toolName === "open_tab") return renderOpenTab(payload, detail);
  if (toolName === "browser_action" || toolName === "browser_verify") return renderBrowser(payload, detail);
  if (["bash", "read_file", "write_file", "edit_file", "invoke"].includes(toolName)) {
    return renderInvoke(toolName, callId, payload, detail);
  }
  return renderDefault(toolName, callId, payload, detail);
}
