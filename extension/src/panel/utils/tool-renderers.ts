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

const INVOKE_BASH_TOOL_NAMES = new Set(["host_bash", "browser_bash"]);
const INVOKE_FILE_TOOL_NAMES = new Set([
  "host_read_file",
  "browser_read_file",
  "host_write_file",
  "browser_write_file",
  "host_edit_file",
  "browser_edit_file"
]);
const INVOKE_TOOL_NAMES = new Set([
  ...INVOKE_BASH_TOOL_NAMES,
  ...INVOKE_FILE_TOOL_NAMES,
  "invoke"
]);

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toText(value: unknown): string {
  return String(value || "").trim();
}

function toScalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
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

function clipText(value: string, max: number): string {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sanitizeOutput(value: unknown, max: number): string {
  const text = toScalarText(value);
  if (!text) return "";
  const normalized = text
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!normalized) return "";
  return clipText(normalized, max);
}

function formatRawDetail(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) {
    return "结构化结果（原始 JSON 已省略）";
  }
  return clipText(text, 600);
}

function collectCandidateRecords(root: JsonRecord): JsonRecord[] {
  const out: JsonRecord[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<unknown>();
  const MAX_DEPTH = 4;
  const NESTED_KEYS = ["response", "data", "details", "result", "payload", "body"];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > MAX_DEPTH) continue;
    const value = current.value;
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const record = value as JsonRecord;
    out.push(record);
    for (const key of NESTED_KEYS) {
      const nested = record[key];
      if (nested && typeof nested === "object") {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }

  return out;
}

function pickTextFromRecords(records: JsonRecord[], keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = toScalarText(record[key]);
      if (value) return value;
    }
  }
  return "";
}

function pickNumberFromRecords(records: JsonRecord[], key: string): number | null {
  for (const record of records) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickBooleanFromRecords(records: JsonRecord[], key: string): boolean | null {
  for (const record of records) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && value.trim()) {
      const lower = value.trim().toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
  }
  return null;
}

function summarizeScalarFields(records: JsonRecord[]): string {
  const ignoreKeys = new Set([
    "tool",
    "target",
    "args",
    "rawArgs",
    "response",
    "data",
    "details",
    "result",
    "payload",
    "body",
    "stdout",
    "stderr",
    "content",
    "text",
    "preview",
    "error",
    "errorCode",
    "verifyReason",
    "verified"
  ]);
  const items: string[] = [];
  const seen = new Set<string>();
  const MAX_ITEMS = 6;

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (items.length >= MAX_ITEMS) return items.join(" · ");
      if (ignoreKeys.has(key)) continue;
      const text = toScalarText(value);
      if (!text) continue;
      const normalized = clipText(text, 96);
      const token = `${key}:${normalized}`;
      if (seen.has(token)) continue;
      seen.add(token);
      items.push(`${key}=${normalized}`);
    }
  }

  return items.join(" · ");
}

function formatDetail(raw: string, payload: unknown, parsed: boolean, toolName: string): string {
  if (!parsed) return formatRawDetail(raw);
  const record = asRecord(payload);
  if (!Object.keys(record).length) return formatRawDetail(raw);

  const records = collectCandidateRecords(record);
  const sections: string[] = [];
  const target = toText(record.target) || pickTextFromRecords(records, ["target"]);
  if (target) sections.push(target);

  const metrics: string[] = [];
  const exitCode = pickNumberFromRecords(records, "exitCode");
  if (exitCode !== null) metrics.push(`exitCode=${exitCode}`);
  const durationMs = pickNumberFromRecords(records, "durationMs");
  if (durationMs !== null) metrics.push(`duration=${durationMs}ms`);
  const bytesWritten = pickNumberFromRecords(records, "bytesWritten");
  if (bytesWritten !== null) metrics.push(`bytesWritten=${bytesWritten}`);
  const hunks = pickNumberFromRecords(records, "hunks");
  if (hunks !== null) metrics.push(`hunks=${hunks}`);
  const replacements = pickNumberFromRecords(records, "replacements");
  if (replacements !== null) metrics.push(`replacements=${replacements}`);
  const truncated = pickBooleanFromRecords(records, "truncated");
  if (truncated === true) metrics.push("输出已截断");
  const verified = pickBooleanFromRecords(records, "verified");
  if (verified === true) metrics.push("verified=true");
  if (verified === false && ["browser_action", "browser_verify"].includes(String(toolName || "").trim().toLowerCase())) {
    metrics.push("verified=false");
  }
  if (metrics.length) sections.push(metrics.join(" · "));

  const verifyReason = sanitizeOutput(pickTextFromRecords(records, ["verifyReason"]), 280);
  if (verifyReason) sections.push(`verify\n${verifyReason}`);

  const errorCode = sanitizeOutput(pickTextFromRecords(records, ["errorCode"]), 120);
  if (errorCode) sections.push(`errorCode\n${errorCode}`);
  const errorText = sanitizeOutput(pickTextFromRecords(records, ["error"]), 480);
  if (errorText) sections.push(`error\n${errorText}`);

  const stdout = sanitizeOutput(pickTextFromRecords(records, ["stdout"]), 1200);
  const stderr = sanitizeOutput(pickTextFromRecords(records, ["stderr"]), 1000);
  const content = sanitizeOutput(pickTextFromRecords(records, ["content"]), 1200);
  const textOut = sanitizeOutput(pickTextFromRecords(records, ["text", "preview"]), 1200);

  if (stdout) sections.push(`stdout\n${stdout}`);
  if (stderr) sections.push(`stderr\n${stderr}`);
  if (!stdout && !stderr && content) sections.push(`output\n${content}`);
  if (!stdout && !stderr && !content && textOut) sections.push(`output\n${textOut}`);

  if (!sections.length) {
    const scalarSummary = summarizeScalarFields(records);
    if (scalarSummary) sections.push(scalarSummary);
  }
  if (!sections.length) sections.push("结构化结果（已省略原始 payload）");

  return clipText(sections.join("\n\n"), 2200);
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

  if (INVOKE_BASH_TOOL_NAMES.has(normalized)) {
    const command = toText(args.command) || toText(payload.rawArgs);
    return command ? `命令：${command}` : "";
  }
  if (INVOKE_FILE_TOOL_NAMES.has(normalized)) {
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
  const bridgeResponseData = asRecord(bridgeResponse.data);
  const bridgeResponseInner = asRecord(bridgeResponseData.data);
  const bridgeTool = toText(asRecord(invokeResult.data).echoedTool) || toText(bridgeResponseInner.echoedTool);
  const toolLabel = toolName || bridgeTool || "invoke";
  const invokeId = toText(invokeResult.id) || toText(bridgeResponseData.id) || callId;
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
  const detail = formatDetail(content, payload, parsed.ok, toolName);

  if (toolName === "snapshot") return renderSnapshot(payload, detail);
  if (toolName === "list_tabs") return renderListTabs(payload, detail);
  if (toolName === "open_tab") return renderOpenTab(payload, detail);
  if (toolName === "browser_action" || toolName === "browser_verify") return renderBrowser(payload, detail);
  if (INVOKE_TOOL_NAMES.has(toolName)) {
    return renderInvoke(toolName, callId, payload, detail);
  }
  return renderDefault(toolName, callId, payload, detail);
}
