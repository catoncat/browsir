type JsonRecord = Record<string, unknown>;

interface RuntimeResponse<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string;
}

interface CollectDiagnosticsOptions {
  sessionId?: string;
  recentEvents?: Array<Record<string, unknown>>;
  timelineLimit?: number;
  llmLimit?: number;
  toolLimit?: number;
  eventLimit?: number;
  conversationTailLimit?: number;
}

interface CollectedDiagnostics {
  payload: JsonRecord;
  text: string;
}

interface PublishDiagnosticsOptions extends CollectDiagnosticsOptions {
  bridgeUrl: string;
  bridgeToken: string;
  title?: string;
}

interface PublishedDiagnosticsResult {
  payload: JsonRecord;
  exportId: string;
  downloadUrl: string;
  item: JsonRecord;
}

interface NormalizedStepEvent {
  idx: number;
  ts: string;
  type: string;
  payload: JsonRecord;
}

interface LlmEventPoint {
  idx: number;
  ts: string;
  type: string;
  data: JsonRecord;
}

interface ToolEventPoint {
  idx: number;
  ts: string;
  type: string;
  data: JsonRecord;
}

interface CompactTable {
  columns: string[];
  rows: unknown[][];
}

interface SandboxTelemetryRow {
  ts: string;
  type: string;
  reason?: string;
  durationMs?: number;
  bytes?: number;
  fileCount?: number;
  namespaceCount?: number;
  persistedNamespaceCount?: number;
  forced?: boolean;
  dirty?: boolean;
  command?: string;
  exitCode?: number;
  timeoutHit?: boolean;
}

const SANITIZE_MAX_DEPTH = 5;
const SANITIZE_MAX_ARRAY = 80;
const SANITIZE_MAX_OBJECT_KEYS = 80;
const SANITIZE_MAX_STRING = 1800;
const DIAGNOSTICS_STEP_STREAM_MAX_EVENTS = 5000;
const DIAGNOSTICS_STEP_STREAM_MAX_BYTES = 4 * 1024 * 1024;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function clipText(value: unknown, max = 220): string {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function resolveBridgeHttpBase(bridgeUrlRaw: unknown): string {
  const fallback = "http://127.0.0.1:8787";
  const raw = String(bridgeUrlRaw || "").trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "ws:") return `http://${parsed.host}`;
    if (parsed.protocol === "wss:") return `https://${parsed.host}`;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function appendBridgeTokenToUrl(urlRaw: string, token: string): string {
  const url = new URL(urlRaw);
  url.searchParams.set("token", token);
  return url.toString();
}

async function sendMessage<T = unknown>(type: string, payload: JsonRecord = {}): Promise<T> {
  const out = (await chrome.runtime.sendMessage({ type, ...payload })) as RuntimeResponse<T>;
  if (!out?.ok) {
    throw new Error(String(out?.error || `${type} failed`));
  }
  return out.data as T;
}

function toPositiveInt(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function normalizeTs(value: unknown): string {
  const text = String(value || "").trim();
  return text || new Date().toISOString();
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return clipText(value, SANITIZE_MAX_STRING);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= SANITIZE_MAX_DEPTH) return "[max_depth_reached]";

  if (Array.isArray(value)) {
    const sliced = value.slice(0, SANITIZE_MAX_ARRAY);
    const mapped = sliced.map((item) => sanitizeValue(item, depth + 1));
    if (value.length > SANITIZE_MAX_ARRAY) {
      mapped.push(`[truncated ${value.length - SANITIZE_MAX_ARRAY} items]`);
    }
    return mapped;
  }

  const record = toRecord(value);
  const keys = Object.keys(record).slice(0, SANITIZE_MAX_OBJECT_KEYS);
  const out: JsonRecord = {};
  for (const key of keys) {
    out[key] = sanitizeValue(record[key], depth + 1);
  }
  if (Object.keys(record).length > SANITIZE_MAX_OBJECT_KEYS) {
    out.__truncated_keys__ = Object.keys(record).length - SANITIZE_MAX_OBJECT_KEYS;
  }
  return out;
}

function normalizeStepEvents(stepStream: unknown): NormalizedStepEvent[] {
  const rows = Array.isArray(stepStream) ? stepStream : [];
  const events: NormalizedStepEvent[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = toRecord(rows[i]);
    events.push({
      idx: i,
      ts: normalizeTs(row.ts || row.timestamp),
      type: String(row.type || "unknown").trim() || "unknown",
      payload: toRecord(row.payload)
    });
  }

  return events;
}

function normalizeStepTimeline(stepStream: unknown, limit = 24): string[] {
  const rows = normalizeStepEvents(stepStream);
  const lines: string[] = [];

  for (const row of rows) {
    const type = row.type;
    const payload = row.payload;
    if (!type) continue;

    if (type === "step_planned" && String(payload.mode || "") === "tool_call") {
      const step = Number(payload.step || 0);
      const action = String(payload.action || "").trim();
      const args = clipText(payload.arguments, 120);
      lines.push(`步骤${step || "?"} 计划 ${action || "tool"}${args ? ` · ${args}` : ""}`);
      continue;
    }
    if (type === "step_finished" && String(payload.mode || "") === "tool_call") {
      const step = Number(payload.step || 0);
      const action = String(payload.action || "").trim();
      const ok = payload.ok === true;
      const err = clipText(payload.error, 120);
      lines.push(`步骤${step || "?"} ${ok ? "完成" : "失败"} ${action || "tool"}${err ? ` · ${err}` : ""}`);
      continue;
    }
    if (type === "loop_start") {
      lines.push("Loop 启动");
      continue;
    }
    if (type === "loop_done") {
      lines.push(`Loop 结束 · status=${String(payload.status || "unknown")}`);
      continue;
    }
    if (type === "loop_error") {
      lines.push(`Loop 错误 · ${clipText(payload.message, 140)}`);
      continue;
    }
    if (type === "llm.request") {
      const mode = String(payload.mode || "").trim();
      const summaryMode = String(payload.summaryMode || "").trim();
      const source = String(payload.source || "").trim();
      if (mode === "compaction") {
        lines.push(`LLM 摘要请求 · mode=${summaryMode || "history"} · model=${String(payload.model || "")}`);
      } else if (source === "hosted_chat_transport") {
        lines.push(`Hosted transport 请求 · model=${String(payload.model || "")}`);
      } else {
        lines.push(`LLM 请求 · model=${String(payload.model || "")}`);
      }
      continue;
    }
    if (type === "llm.response.parsed") {
      if (String(payload.source || "").trim() === "hosted_chat_transport") {
        lines.push(`Hosted turn 解析 · toolCalls=${String(payload.toolCalls || 0)}`);
      } else {
        lines.push(`LLM 解析 · toolCalls=${String(payload.toolCalls || 0)}`);
      }
      continue;
    }
    if (type === "hosted_chat.debug") {
      lines.push(`Hosted transport · ${clipText(payload.stage || payload.detail, 140)}`);
      continue;
    }
    if (type === "hosted_chat.tool_call_detected") {
      lines.push(`Hosted 工具提取 · toolCalls=${String(payload.toolCalls || 0)}`);
      continue;
    }
    if (type === "hosted_chat.turn_resolved") {
      lines.push(`Hosted 回合完成 · finish=${String(payload.finishReason || "stop")}`);
      continue;
    }
    if (type === "hosted_chat.transport_error") {
      lines.push(`Hosted transport 错误 · ${clipText(payload.error || payload.message, 140)}`);
      continue;
    }
    if (type === "auto_retry_start") {
      lines.push(`自动重试开始 · attempt=${String(payload.attempt || "?")}`);
      continue;
    }
    if (type === "auto_retry_end") {
      lines.push(`自动重试结束 · success=${String(payload.success === true)}`);
      continue;
    }
  }
  return lines.slice(-Math.max(1, limit));
}

function findLastError(stepStream: unknown): string {
  const rows = normalizeStepEvents(stepStream);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const record = rows[i];
    const type = String(record.type || "");
    const payload = record.payload;
    if (type === "loop_error") return clipText(payload.message, 220);
    if (type === "step_finished" && payload.ok === false) {
      return clipText(payload.error || payload.preview, 220);
    }
    if (type === "llm.skipped") {
      return `LLM skipped: ${clipText(payload.reason, 140)}`;
    }
  }
  return "";
}

function summarizeRecentEvents(events: Array<Record<string, unknown>>, limit = 16): string[] {
  const rows = Array.isArray(events) ? events : [];
  const tail = rows.slice(-Math.max(1, limit));
  return tail.map((row) => {
    const record = toRecord(row);
    const source = String(record.source || "runtime");
    const type = String(record.type || record.event || "unknown");
    const ts = String(record.ts || record.timestamp || "").trim();
    const preview = clipText(record.preview || record.message || "", 100);
    const head = `[${source}] ${type}`;
    const middle = ts ? ` @ ${ts}` : "";
    return `${head}${middle}${preview ? ` · ${preview}` : ""}`;
  });
}

function buildFallbackRecentEventsFromStepStream(
  events: NormalizedStepEvent[],
  limit = 16
): Array<Record<string, unknown>> {
  return events.slice(-Math.max(1, limit)).map((event) => {
    const payload = event.payload;
    const preview = clipText(
      payload.error || payload.message || payload.action || payload.arguments || payload.reason || payload.preview || "",
      140
    );
    return {
      source: "trace",
      type: event.type,
      ts: event.ts,
      preview
    };
  });
}

function buildEventTypeCounts(events: NormalizedStepEvent[]): JsonRecord {
  const counts: JsonRecord = {};
  for (const event of events) {
    const key = event.type || "unknown";
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return counts;
}

function buildConversationTail(messages: unknown, limit = 14): Array<Record<string, unknown>> {
  const rows = Array.isArray(messages) ? messages : [];
  const tail = rows.slice(-Math.max(1, limit));
  const offset = rows.length - tail.length;
  return tail.map((row, idx) => {
    const message = toRecord(row);
    return {
      index: offset + idx + 1,
      role: String(message.role || ""),
      entryId: String(message.entryId || ""),
      toolName: String(message.toolName || ""),
      toolCallId: String(message.toolCallId || ""),
      content: clipText(message.content, 1800)
    };
  });
}

function buildCompactTable<TRow extends object>(
  rows: TRow[],
  preferredColumns: string[] = []
): CompactTable {
  const columnSet = new Set<string>();
  const columns: string[] = [];

  for (const column of preferredColumns) {
    if (!column || columnSet.has(column)) continue;
    columnSet.add(column);
    columns.push(column);
  }

  for (const row of rows) {
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (columnSet.has(key)) continue;
      columnSet.add(key);
      columns.push(key);
    }
  }

  return {
    columns,
    rows: rows.map((row) => {
      const record = row as Record<string, unknown>;
      return columns.map((column) => sanitizeValue(record[column]));
    })
  };
}

function flattenEventPoint(point: { idx: number; ts: string; type: string; data: JsonRecord }): Record<string, unknown> {
  return {
    idx: point.idx,
    ts: point.ts,
    type: point.type,
    ...point.data
  };
}

function buildSandboxTimeline(sandboxSession: JsonRecord): string[] {
  const summary = toRecord(sandboxSession.summary);
  const lines: string[] = [];
  const flushCount = Number(summary.flushCount || 0);
  const skipped = Number(summary.flushSkippedCount || 0);
  const timeouts = Number(summary.commandTimeoutCount || 0);
  const lastFlushReason = String(summary.lastFlushReason || "").trim();
  const lastFlushMs = Number(summary.lastFlushDurationMs || 0);
  const lastFlushFiles = Number(summary.lastFlushFiles || 0);
  const lastFlushBytes = Number(summary.lastFlushBytes || 0);
  const lastCommand = clipText(summary.lastCommand, 80);
  const lastCommandExitCode = summary.lastCommandExitCode;

  if (flushCount > 0) {
    lines.push(
      `Sandbox flush ${flushCount} 次` +
        (lastFlushReason ? ` · 最近=${lastFlushReason}` : "") +
        (lastFlushFiles > 0 ? ` · ${lastFlushFiles} files` : "") +
        (lastFlushBytes > 0 ? ` · ${lastFlushBytes} bytes` : "") +
        (lastFlushMs > 0 ? ` · ${lastFlushMs}ms` : "")
    );
  }
  if (skipped > 0) {
    lines.push(`Sandbox flush 合并跳过 ${skipped} 次`);
  }
  if (lastCommand) {
    lines.push(
      `Sandbox command · ${lastCommand}` +
        (lastCommandExitCode != null ? ` · exit=${String(lastCommandExitCode)}` : "") +
        (timeouts > 0 ? ` · timeout=${timeouts}` : "")
    );
  }
  return lines.slice(-3);
}

function buildSandboxTrace(sandboxSession: JsonRecord, limit = 32): SandboxTelemetryRow[] {
  const recent = Array.isArray(sandboxSession.recent) ? sandboxSession.recent : [];
  return recent.slice(-Math.max(1, limit)).map((item) => {
    const row = toRecord(item);
    return {
      ts: normalizeTs(row.ts),
      type: String(row.type || "unknown"),
      reason: String(row.reason || ""),
      durationMs: toPositiveInt(row.durationMs),
      bytes: toPositiveInt(row.bytes),
      fileCount: toPositiveInt(row.fileCount),
      namespaceCount: toPositiveInt(row.namespaceCount),
      persistedNamespaceCount: toPositiveInt(row.persistedNamespaceCount),
      forced: row.forced === true,
      dirty: row.dirty === true,
      command: clipText(row.command, 180),
      exitCode:
        row.exitCode == null || row.exitCode === ""
          ? undefined
          : Number(row.exitCode),
      timeoutHit: row.timeoutHit === true
    };
  });
}

function summarizeLlmRequestPayload(payload: JsonRecord): JsonRecord {
  const req = toRecord(payload.payload);
  const messages = Array.isArray(req.messages) ? req.messages : [];
  let lastUser = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = toRecord(messages[i]);
    if (String(message.role || "") !== "user") continue;
    lastUser = clipText(message.content, 420);
    if (lastUser) break;
  }
  const toolResultCount = messages.reduce((count, item) => {
    const message = toRecord(item);
    return String(message.role || "") === "tool" ? count + 1 : count;
  }, 0);
  const fallbackMessageChars = messages.reduce((count, item) => {
    const message = toRecord(item);
    return count + String(message.content || "").length;
  }, 0);
  return {
    model: String(payload.model || ""),
    step: toPositiveInt(payload.step),
    messageCount: toPositiveInt(payload.messageCount) ?? messages.length,
    messageChars: toPositiveInt(payload.messageChars) ?? fallbackMessageChars,
    maxMessageChars: toPositiveInt(payload.maxMessageChars),
    url: String(payload.url || ""),
    requestBytes: toPositiveInt(payload.requestBytes),
    requestMessageCount: messages.length || toPositiveInt(payload.messageCount) || 0,
    toolResultCount: toPositiveInt(payload.toolMessageCount) ?? toolResultCount,
    hasToolsDefinition:
      (toPositiveInt(payload.toolDefinitionCount) ?? 0) > 0 || (Array.isArray(req.tools) && req.tools.length > 0),
    lastUserSnippet: String(payload.lastUserSnippet || "") || lastUser
  };
}

function buildLlmTrace(events: NormalizedStepEvent[], limit = 80): LlmEventPoint[] {
  const output: LlmEventPoint[] = [];
  const acceptedTypes = new Set([
    "llm.request",
    "llm.response.raw",
    "llm.response.parsed",
    "llm.stream.start",
    "llm.stream.end",
    "hosted_chat.debug",
    "hosted_chat.tool_call_detected",
    "hosted_chat.turn_resolved",
    "hosted_chat.transport_error",
    "llm.skipped",
    "auto_retry_start",
    "auto_retry_end"
  ]);

  for (const event of events) {
    if (!acceptedTypes.has(event.type)) continue;
    const payload = event.payload;
    const point: LlmEventPoint = {
      idx: event.idx,
      ts: event.ts,
      type: event.type,
      data: {}
    };

    if (event.type === "llm.request") {
      point.data = {
        ...summarizeLlmRequestPayload(payload),
        source: String(payload.source || "") || "llm_provider"
      };
    } else if (event.type === "llm.response.raw") {
      const rawBody = String(payload.body || payload.bodyPreview || "");
      point.data = {
        step: toPositiveInt(payload.step),
        attempt: toPositiveInt(payload.attempt),
        status: Number(payload.status || 0),
        ok: payload.ok === true,
        bodyLength: toPositiveInt(payload.bodyLength) ?? rawBody.length,
        bodyTruncated: payload.bodyTruncated === true,
        body: clipText(rawBody, 1200)
      };
    } else if (event.type === "llm.response.parsed") {
      point.data = {
        step: toPositiveInt(payload.step),
        toolCalls: toPositiveInt(payload.toolCalls),
        hasText: payload.hasText === true,
        source: String(payload.source || "") || "llm_provider"
      };
    } else if (event.type === "llm.stream.start") {
      point.data = {
        step: toPositiveInt(payload.step),
        attempt: toPositiveInt(payload.attempt)
      };
    } else if (event.type === "llm.stream.end") {
      point.data = {
        step: toPositiveInt(payload.step),
        attempt: toPositiveInt(payload.attempt),
        packetCount: toPositiveInt(payload.packetCount),
        contentLength: toPositiveInt(payload.contentLength),
        toolCalls: toPositiveInt(payload.toolCalls)
      };
    } else if (event.type === "hosted_chat.debug") {
      point.data = {
        step: toPositiveInt(payload.step),
        attempt: toPositiveInt(payload.attempt),
        stage: String(payload.stage || ""),
        detail: String(payload.detail || "")
      };
    } else if (event.type === "hosted_chat.tool_call_detected") {
      point.data = {
        step: toPositiveInt(payload.step),
        attempt: toPositiveInt(payload.attempt),
        toolCalls: toPositiveInt(payload.toolCalls),
        assistantTextLength: toPositiveInt(payload.assistantTextLength)
      };
    } else if (event.type === "hosted_chat.turn_resolved") {
      point.data = {
        step: toPositiveInt(payload.step),
        attempt: toPositiveInt(payload.attempt),
        finishReason: String(payload.finishReason || ""),
        toolCalls: toPositiveInt(payload.toolCalls),
        assistantTextLength: toPositiveInt(payload.assistantTextLength)
      };
    } else if (event.type === "hosted_chat.transport_error") {
      point.data = {
        step: toPositiveInt(payload.step),
        attempt: toPositiveInt(payload.attempt),
        error: clipText(payload.error || payload.message, 240)
      };
    } else if (event.type === "llm.skipped") {
      point.data = {
        reason: String(payload.reason || ""),
        hasBase: payload.hasBase === true,
        hasKey: payload.hasKey === true
      };
    } else if (event.type === "auto_retry_start") {
      point.data = {
        attempt: toPositiveInt(payload.attempt),
        maxAttempts: toPositiveInt(payload.maxAttempts),
        delayMs: toPositiveInt(payload.delayMs),
        status: Number(payload.status || 0),
        reason: String(payload.reason || "")
      };
    } else if (event.type === "auto_retry_end") {
      point.data = {
        success: payload.success === true,
        attempt: toPositiveInt(payload.attempt),
        maxAttempts: toPositiveInt(payload.maxAttempts),
        finalError: String(payload.finalError || "")
      };
    }

    output.push(point);
  }

  return output.slice(-Math.max(1, limit));
}

function buildToolTrace(events: NormalizedStepEvent[], limit = 120): ToolEventPoint[] {
  const output: ToolEventPoint[] = [];
  const acceptedTypes = new Set([
    "step_planned",
    "step_finished",
    "step_execute",
    "step_execute_result"
  ]);

  for (const event of events) {
    if (!acceptedTypes.has(event.type)) continue;
    const payload = event.payload;
    const mode = String(payload.mode || "").trim();
    const point: ToolEventPoint = {
      idx: event.idx,
      ts: event.ts,
      type: event.type,
      data: {}
    };

    if (event.type === "step_planned") {
      if (mode !== "tool_call") continue;
      point.data = {
        step: toPositiveInt(payload.step),
        mode,
        action: String(payload.action || ""),
        arguments: clipText(payload.arguments, 900)
      };
      output.push(point);
      continue;
    }

    if (event.type === "step_finished") {
      if (mode !== "tool_call") continue;
      point.data = {
        step: toPositiveInt(payload.step),
        mode,
        action: String(payload.action || ""),
        ok: payload.ok === true,
        error: clipText(payload.error, 1000),
        preview: clipText(payload.preview, 1000),
        modeUsed: String(payload.modeUsed || ""),
        providerId: String(payload.providerId || ""),
        fallbackFrom: String(payload.fallbackFrom || "")
      };
      output.push(point);
      continue;
    }

    if (event.type === "step_execute") {
      point.data = {
        mode: String(payload.mode || ""),
        action: String(payload.action || ""),
        capability: String(payload.capability || ""),
        providerId: String(payload.providerId || "")
      };
      output.push(point);
      continue;
    }

    if (event.type === "step_execute_result") {
      point.data = {
        ok: payload.ok === true,
        modeUsed: String(payload.modeUsed || ""),
        providerId: String(payload.providerId || ""),
        fallbackFrom: String(payload.fallbackFrom || ""),
        verified: payload.verified === true,
        verifyReason: String(payload.verifyReason || ""),
        errorCode: String(payload.errorCode || ""),
        error: clipText(payload.error, 420),
        retryable: payload.retryable === true
      };
      output.push(point);
    }
  }

  return output.slice(-Math.max(1, limit));
}

function buildLoopRuns(events: NormalizedStepEvent[]): Array<Record<string, unknown>> {
  const runs: Array<Record<string, unknown>> = [];
  let current: {
    runId: number;
    startIdx: number;
    startTs: string;
    prompt: string;
    endIdx: number;
    endTs: string;
    status: string;
    loopError: string;
    llmRequestCount: number;
    llmParsedCount: number;
    llmParsedWithToolCalls: number;
    llmParsedWithText: number;
    llmToolCallTotal: number;
    llmStreamStarts: number;
    llmStreamEnds: number;
    llmStreamPackets: number;
    llmStreamChars: number;
    retryStartCount: number;
    retryEndCount: number;
    retryFailureCount: number;
    toolPlannedCount: number;
    toolFinishedOkCount: number;
    toolFinishedFailCount: number;
    toolActions: Map<string, { planned: number; ok: number; fail: number; lastError: string }>;
  } | null = null;

  let runSeed = 0;

  const flushCurrent = (fallbackStatus: string) => {
    if (!current) return;
    const actionSummary: JsonRecord = {};
    for (const [action, stats] of current.toolActions.entries()) {
      actionSummary[action] = {
        planned: stats.planned,
        ok: stats.ok,
        fail: stats.fail,
        lastError: stats.lastError
      };
    }
    runs.push({
      runId: current.runId,
      startIdx: current.startIdx,
      endIdx: current.endIdx >= 0 ? current.endIdx : null,
      startTs: current.startTs,
      endTs: current.endTs || null,
      status: current.status || fallbackStatus,
      prompt: current.prompt,
      loopError: current.loopError,
      llm: {
        requestCount: current.llmRequestCount,
        parsedCount: current.llmParsedCount,
        parsedWithToolCalls: current.llmParsedWithToolCalls,
        parsedWithText: current.llmParsedWithText,
        toolCallTotal: current.llmToolCallTotal,
        streamStarts: current.llmStreamStarts,
        streamEnds: current.llmStreamEnds,
        streamPackets: current.llmStreamPackets,
        streamChars: current.llmStreamChars,
        retryStartCount: current.retryStartCount,
        retryEndCount: current.retryEndCount,
        retryFailureCount: current.retryFailureCount
      },
      tool: {
        plannedCount: current.toolPlannedCount,
        finishedOkCount: current.toolFinishedOkCount,
        finishedFailCount: current.toolFinishedFailCount,
        actions: actionSummary
      }
    });
    current = null;
  };

  for (const event of events) {
    const payload = event.payload;
    const type = event.type;

    if (type === "loop_start") {
      flushCurrent("interrupted");
      runSeed += 1;
      current = {
        runId: runSeed,
        startIdx: event.idx,
        startTs: event.ts,
        prompt: clipText(payload.prompt, 360),
        endIdx: -1,
        endTs: "",
        status: "",
        loopError: "",
        llmRequestCount: 0,
        llmParsedCount: 0,
        llmParsedWithToolCalls: 0,
        llmParsedWithText: 0,
        llmToolCallTotal: 0,
        llmStreamStarts: 0,
        llmStreamEnds: 0,
        llmStreamPackets: 0,
        llmStreamChars: 0,
        retryStartCount: 0,
        retryEndCount: 0,
        retryFailureCount: 0,
        toolPlannedCount: 0,
        toolFinishedOkCount: 0,
        toolFinishedFailCount: 0,
        toolActions: new Map()
      };
      continue;
    }

    if (!current) continue;

    if (type === "llm.request") {
      current.llmRequestCount += 1;
      continue;
    }
    if (type === "llm.response.parsed") {
      current.llmParsedCount += 1;
      const toolCalls = toPositiveInt(payload.toolCalls);
      current.llmToolCallTotal += toolCalls;
      if (toolCalls > 0) current.llmParsedWithToolCalls += 1;
      if (payload.hasText === true) current.llmParsedWithText += 1;
      continue;
    }
    if (type === "llm.stream.start") {
      current.llmStreamStarts += 1;
      continue;
    }
    if (type === "llm.stream.end") {
      current.llmStreamEnds += 1;
      current.llmStreamPackets += toPositiveInt(payload.packetCount);
      current.llmStreamChars += toPositiveInt(payload.contentLength);
      continue;
    }
    if (type === "auto_retry_start") {
      current.retryStartCount += 1;
      continue;
    }
    if (type === "auto_retry_end") {
      current.retryEndCount += 1;
      if (payload.success !== true) current.retryFailureCount += 1;
      continue;
    }

    if (type === "step_planned" && String(payload.mode || "") === "tool_call") {
      current.toolPlannedCount += 1;
      const action = String(payload.action || "").trim() || "unknown_tool";
      const existing = current.toolActions.get(action) || { planned: 0, ok: 0, fail: 0, lastError: "" };
      existing.planned += 1;
      current.toolActions.set(action, existing);
      continue;
    }

    if (type === "step_finished" && String(payload.mode || "") === "tool_call") {
      const action = String(payload.action || "").trim() || "unknown_tool";
      const existing = current.toolActions.get(action) || { planned: 0, ok: 0, fail: 0, lastError: "" };
      if (payload.ok === true) {
        current.toolFinishedOkCount += 1;
        existing.ok += 1;
      } else {
        current.toolFinishedFailCount += 1;
        existing.fail += 1;
        existing.lastError = clipText(payload.error, 300);
      }
      current.toolActions.set(action, existing);
      continue;
    }

    if (type === "loop_error") {
      current.loopError = clipText(payload.message, 460);
      continue;
    }

    if (type === "loop_done") {
      current.endIdx = event.idx;
      current.endTs = event.ts;
      current.status = String(payload.status || "").trim() || "unknown";
      flushCurrent("done");
    }
  }

  flushCurrent("unfinished");
  return runs;
}

function buildRawEventTail(events: NormalizedStepEvent[], limit = 72): Array<Record<string, unknown>> {
  const tail = events.slice(-Math.max(1, limit));
  return tail.map((event) => ({
    idx: event.idx,
    ts: event.ts,
    type: event.type,
    payload: sanitizeValue(event.payload)
  }));
}

function buildDiagnosticsText(payload: JsonRecord): string {
  // 复制内容优先服务 AI：稳定标记 + 结构化 JSON，便于索引和解析。
  return [
    "[[BBL_DIAGNOSTIC_V4]]",
    JSON.stringify(payload, null, 2),
    "[[/BBL_DIAGNOSTIC_V4]]"
  ].join("\n");
}

function buildRecentEventsSummary(
  recentEventsInput: Array<Record<string, unknown>>,
  events: NormalizedStepEvent[]
): string[] {
  if (Array.isArray(recentEventsInput) && recentEventsInput.length > 0) {
    return summarizeRecentEvents(recentEventsInput, 16);
  }
  const fallback = buildFallbackRecentEventsFromStepStream(events, 16);
  return summarizeRecentEvents(fallback, 16);
}

function buildAgentDecisionTrace(events: NormalizedStepEvent[], limit = 80): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const accepted = new Set([
    "loop_start",
    "loop_done",
    "loop_error",
    "loop_skip_stopped",
    "loop_enqueue_skipped",
    "loop_restart",
    "step_planned",
    "step_finished",
    "llm.response.parsed",
    "hosted_chat.tool_call_detected",
    "hosted_chat.turn_resolved",
    "hosted_chat.transport_error"
  ]);

  for (const event of events) {
    if (!accepted.has(event.type)) continue;
    const payload = event.payload;
    const row: Record<string, unknown> = {
      idx: event.idx,
      ts: event.ts,
      type: event.type
    };

    if (event.type === "loop_start") {
      row.prompt = clipText(payload.prompt, 320);
    } else if (event.type === "loop_done") {
      row.status = String(payload.status || "");
      row.llmSteps = toPositiveInt(payload.llmSteps);
      row.toolSteps = toPositiveInt(payload.toolSteps);
    } else if (event.type === "loop_error") {
      row.message = clipText(payload.message, 400);
    } else if (event.type === "step_planned") {
      row.mode = String(payload.mode || "");
      row.step = toPositiveInt(payload.step);
      row.action = String(payload.action || "");
      row.arguments = clipText(payload.arguments, 900);
    } else if (event.type === "step_finished") {
      row.mode = String(payload.mode || "");
      row.step = toPositiveInt(payload.step);
      row.action = String(payload.action || "");
      row.ok = payload.ok === true;
      row.error = clipText(payload.error, 360);
      row.preview = clipText(payload.preview, 360);
      row.modeUsed = String(payload.modeUsed || "");
      row.providerId = String(payload.providerId || "");
      row.fallbackFrom = String(payload.fallbackFrom || "");
    } else if (event.type === "llm.response.parsed") {
      row.step = toPositiveInt(payload.step);
      row.toolCalls = toPositiveInt(payload.toolCalls);
      row.hasText = payload.hasText === true;
      row.source = String(payload.source || "") || "llm_provider";
    } else if (event.type === "hosted_chat.tool_call_detected") {
      row.step = toPositiveInt(payload.step);
      row.toolCalls = toPositiveInt(payload.toolCalls);
      row.phase = "tool_extraction";
    } else if (event.type === "hosted_chat.turn_resolved") {
      row.step = toPositiveInt(payload.step);
      row.toolCalls = toPositiveInt(payload.toolCalls);
      row.finishReason = String(payload.finishReason || "");
      row.phase = "turn_resolved";
    } else if (event.type === "hosted_chat.transport_error") {
      row.step = toPositiveInt(payload.step);
      row.phase = "transport_error";
      row.error = clipText(payload.error || payload.message, 360);
    }

    rows.push(row);
  }

  return rows.slice(-Math.max(1, limit));
}

function buildDiagnosticHints(lastError: string): string[] {
  const hints: string[] = [];
  const err = String(lastError || "");
  if (err.includes("compaction")) {
    hints.push("Compaction 失败 — 检查 llm.trace 中 source=compaction 的行，确认 LLM 响应 format 是否被正确解析");
  }
  if (err.includes("offscreen") || err.includes("createDocument")) {
    hints.push("Offscreen document 错误 — 检查 manifest.json 是否声明 offscreen 权限");
  }
  if (err.includes("LLM HTTP")) {
    hints.push("LLM HTTP 错误 — 检查 llm.trace 中 status 列，确认 provider 配置和网络连接");
  }
  if (err.includes("no_progress") || err.includes("ping-pong")) {
    hints.push("Loop 无进展 — 检查 agent.decisionTrace 中是否存在重复签名或往返模式");
  }
  if (err.includes("timeout")) {
    hints.push("超时 — 检查 llm.trace 中最后一行的 requestBytes 和 messageChars，可能是 payload 过大");
  }
  return hints;
}

function buildContextRefSummary(messages: unknown[]): Array<Record<string, unknown>> {
  const rows = Array.isArray(messages) ? messages : [];
  const out: Array<Record<string, unknown>> = [];
  for (const msg of rows) {
    const m = toRecord(msg);
    if (String(m.role || "") !== "user") continue;
    const metadata = toRecord(m.metadata);
    const refs = Array.isArray(metadata.contextRefs) ? metadata.contextRefs : [];
    if (refs.length === 0) continue;
    for (const ref of refs) {
      const r = toRecord(ref);
      out.push({
        entryId: String(m.entryId || ""),
        id: String(r.id || ""),
        displayPath: String(r.displayPath || ""),
        source: String(r.source || ""),
        runtime: String(r.runtime || ""),
        kind: String(r.kind || ""),
        mode: String(r.mode || ""),
        sizeBytes: r.sizeBytes ?? null,
        summary: clipText(r.summary, 200),
      });
    }
  }
  return out;
}

export async function collectDiagnostics(options: CollectDiagnosticsOptions = {}): Promise<CollectedDiagnostics> {
  const sessionId = String(options.sessionId || "").trim();
  const [config, dump] = await Promise.all([
    sendMessage<Record<string, unknown>>("brain.debug.config"),
    sessionId
      ? sendMessage<Record<string, unknown>>("brain.debug.dump", {
          sessionId,
          maxEvents: DIAGNOSTICS_STEP_STREAM_MAX_EVENTS,
          maxBytes: DIAGNOSTICS_STEP_STREAM_MAX_BYTES
        })
      : sendMessage<Record<string, unknown>>("brain.debug.dump", {
          maxEvents: DIAGNOSTICS_STEP_STREAM_MAX_EVENTS,
          maxBytes: DIAGNOSTICS_STEP_STREAM_MAX_BYTES
        })
  ]);

  const dumpRecord = toRecord(dump);
  const runtime = toRecord(dumpRecord.runtime);
  const conversationView = toRecord(dumpRecord.conversationView);
  const messages = Array.isArray(conversationView.messages) ? conversationView.messages : [];
  const stepStream = Array.isArray(dumpRecord.stepStream) ? (dumpRecord.stepStream as unknown[]) : [];
  const stepStreamMeta = toRecord(dumpRecord.stepStreamMeta);
  const sandboxRuntime = toRecord(dumpRecord.sandboxRuntime);
  const sandboxSession = toRecord(sandboxRuntime.session);
  const events = normalizeStepEvents(stepStream);

  const timeline = normalizeStepTimeline(stepStream, options.timelineLimit ?? 24);
  const sandboxTimeline = buildSandboxTimeline(sandboxSession);
  const lastError = findLastError(stepStream);
  const recentEvents = buildRecentEventsSummary(options.recentEvents || [], events);
  const loopRuns = buildLoopRuns(events);
  const llmTrace = buildLlmTrace(events, options.llmLimit ?? 120);
  const toolTrace = buildToolTrace(events, options.toolLimit ?? 140);
  const rawEventTail = buildRawEventTail(events, options.eventLimit ?? 80);
  const eventTypeCounts = buildEventTypeCounts(events);
  const conversationTail = buildConversationTail(messages, options.conversationTailLimit ?? 14);
  const contextRefSummary = buildContextRefSummary(messages);
  const agentDecisionTrace = buildAgentDecisionTrace(events, 100);
  const sandboxTrace = buildSandboxTrace(sandboxSession, 32);
  const sandboxSummary = toRecord(sandboxSession.summary);
  const sandboxRuntimeInfo = toRecord(sandboxSession.runtime);
  const llmSkipped = events
    .filter((event) => event.type === "llm.skipped")
    .map((event) => ({
      idx: event.idx,
      ts: event.ts,
      reason: String(event.payload.reason || ""),
      hasBase: event.payload.hasBase === true,
      hasKey: event.payload.hasKey === true
    }));

  const payload: JsonRecord = {
    schemaVersion: "bbl.diagnostic.v4",
    diagnosticGuide: {
      preferredLookupOrder: [
        "summary.lastError",
        "timeline",
        "sandbox.summary",
        "sandbox.trace",
        "llm.trace",
        "tools.trace",
        "agent.loopRuns",
        "contextRefs",
        "rawEventTail"
      ],
      jqHints: [
        ".summary.lastError",
        ".sandbox.summary",
        ".sandbox.trace.rows[]",
        ".llm.trace.rows[]",
        ".tools.trace.rows[]",
        ".contextRefs.rows[]"
      ],
      columnIndex: {
        "rawEventTail": { idx: 0, ts: 1, type: 2, payload: 3 },
        "llm.skipped": { idx: 0, ts: 1, reason: 2, hasBase: 3, hasKey: 4 },
        "llm.trace": { idx: 0, ts: 1, type: 2, step: 3, attempt: 4, status: 5, ok: 6, toolCalls: 7, packetCount: 8, contentLength: 9, messageCount: 10, messageChars: 11, maxMessageChars: 12, requestBytes: 13, requestMessageCount: 14, toolResultCount: 15, hasToolsDefinition: 16, model: 17, url: 18, lastUserSnippet: 19, bodyLength: 20, bodyTruncated: 21, body: 22, reason: 23, delayMs: 24, maxAttempts: 25, success: 26, finalError: 27, hasText: 28, hasBase: 29, hasKey: 30, assistantTextLength: 31, finishReason: 32, source: 33, stage: 34, detail: 35, contentType: 36 }
      },
      hints: buildDiagnosticHints(lastError),
    },
    generatedAt: new Date().toISOString(),
    sessionId: sessionId || String(dumpRecord.sessionId || ""),
    config: {
      bridgeUrl: String(toRecord(config).bridgeUrl || ""),
      llmDefaultProfile: String(toRecord(config).llmDefaultProfile || "default"),
      llmAuxProfile: String(toRecord(config).llmAuxProfile || ""),
      llmFallbackProfile: String(toRecord(config).llmFallbackProfile || ""),
      llmProvider: String(toRecord(config).llmProvider || ""),
      llmModel: String(toRecord(config).llmModel || ""),
      hasLlmApiKey: toRecord(config).hasLlmApiKey === true
    },
    summary: {
      running: runtime.running === true,
      stopped: runtime.stopped === true,
      paused: runtime.paused === true,
      messageCount: Number(conversationView.messageCount || messages.length || 0),
      stepCount: events.length,
      stepStreamTruncated: stepStreamMeta.truncated === true,
      lastError,
      sandbox: {
        live: Object.keys(sandboxRuntimeInfo).length > 0,
        dirty: sandboxRuntimeInfo.dirty === true,
        flushCount: Number(sandboxSummary.flushCount || 0),
        flushSkippedCount: Number(sandboxSummary.flushSkippedCount || 0),
        forcedFlushCount: Number(sandboxSummary.forcedFlushCount || 0),
        commandCount: Number(sandboxSummary.commandCount || 0),
        commandTimeoutCount: Number(sandboxSummary.commandTimeoutCount || 0),
        lastFlushAt: String(sandboxSummary.lastFlushAt || ""),
        lastCommandAt: String(sandboxSummary.lastCommandAt || "")
      }
    },
    timeline: [...timeline, ...sandboxTimeline].slice(-(options.timelineLimit ?? 24)),
    recentEvents,
    eventTypeCounts,
    sandbox: {
      summary: sanitizeValue({
        ...sandboxSummary,
        runtime: sandboxRuntimeInfo
      }),
      trace: buildCompactTable(sandboxTrace, [
        "ts",
        "type",
        "reason",
        "durationMs",
        "bytes",
        "fileCount",
        "namespaceCount",
        "persistedNamespaceCount",
        "forced",
        "dirty",
        "command",
        "exitCode",
        "timeoutHit"
      ])
    },
    agent: {
      parentSessionId: String(conversationView.parentSessionId || ""),
      forkedFrom: sanitizeValue(conversationView.forkedFrom),
      runtimeState: sanitizeValue(runtime),
      lastStatus: sanitizeValue(conversationView.lastStatus),
      loopRuns,
      decisionTrace: buildCompactTable(agentDecisionTrace, [
        "idx",
        "ts",
        "type",
        "step",
        "action",
        "ok",
        "status",
        "toolCalls",
        "hasText",
        "mode",
        "prompt",
        "arguments",
        "error",
        "preview",
        "modeUsed",
        "providerId",
        "fallbackFrom",
        "llmSteps",
        "toolSteps",
        "message"
      ]),
      conversationTail: buildCompactTable(conversationTail, [
        "index",
        "role",
        "entryId",
        "toolName",
        "toolCallId",
        "content"
      ])
    },
    llm: {
      skipped: buildCompactTable(llmSkipped, ["idx", "ts", "reason", "hasBase", "hasKey"]),
      trace: buildCompactTable(
        llmTrace.map((point) => flattenEventPoint(point)),
        [
          "idx",
          "ts",
          "type",
          "step",
          "attempt",
          "status",
          "ok",
          "toolCalls",
          "packetCount",
          "contentLength",
          "messageCount",
          "messageChars",
          "maxMessageChars",
          "requestBytes",
          "requestMessageCount",
          "toolResultCount",
          "hasToolsDefinition",
          "model",
          "url",
          "lastUserSnippet",
          "bodyLength",
          "bodyTruncated",
          "body",
          "reason",
          "delayMs",
          "maxAttempts",
          "success",
          "finalError",
          "hasText",
          "hasBase",
          "hasKey",
          "assistantTextLength",
          "finishReason",
          "source",
          "stage",
          "detail",
          "contentType"
        ]
      )
    },
    tools: {
      trace: buildCompactTable(
        toolTrace.map((point) => flattenEventPoint(point)),
        [
          "idx",
          "ts",
          "type",
          "step",
          "mode",
          "action",
          "ok",
          "modeUsed",
          "capability",
          "providerId",
          "fallbackFrom",
          "verified",
          "verifyReason",
          "retryable",
          "arguments",
          "errorCode",
          "error",
          "preview"
        ]
      )
    },
    rawEventTail: buildCompactTable(rawEventTail, ["idx", "ts", "type", "payload"]),
    contextRefs: contextRefSummary.length > 0
      ? buildCompactTable(contextRefSummary, [
          "entryId",
          "id",
          "displayPath",
          "source",
          "runtime",
          "kind",
          "mode",
          "sizeBytes",
          "summary"
        ])
      : null,
    debug: {
      entryCount: Number(dumpRecord.entryCount || 0),
      stepStreamCount: events.length,
      stepStreamMeta: sanitizeValue(stepStreamMeta),
      globalTailCount: Array.isArray(dumpRecord.globalTail) ? dumpRecord.globalTail.length : 0,
      sandboxRuntimeMeta: sanitizeValue({
        schemaVersion: String(sandboxRuntime.schemaVersion || ""),
        totals: toRecord(sandboxRuntime.totals)
      })
    }
  };

  return {
    payload,
    text: buildDiagnosticsText(payload)
  };
}

export async function publishDiagnosticsToBridge(
  options: PublishDiagnosticsOptions
): Promise<PublishedDiagnosticsResult> {
  const bridgeUrl = String(options.bridgeUrl || "").trim();
  const bridgeToken = String(options.bridgeToken || "").trim();
  if (!bridgeUrl) {
    throw new Error("bridgeUrl 未配置");
  }
  if (!bridgeToken) {
    throw new Error("bridgeToken 未配置");
  }

  const { payload } = await collectDiagnostics(options);
  const sessionId = String(payload.sessionId || options.sessionId || "").trim();
  const title = clipText(options.title || sessionId || "未命名会话", 120);
  const baseUrl = resolveBridgeHttpBase(bridgeUrl);

  const response = await fetch(`${baseUrl}/api/diagnostics?token=${encodeURIComponent(bridgeToken)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sessionId,
      title,
      payload
    })
  });

  const result = toRecord(await response.json().catch(() => ({})));
  if (!response.ok || result.ok === false) {
    throw new Error(String(result.error || `publish diagnostics failed: ${response.status}`));
  }

  const resultData = toRecord(result.data);
  const item = toRecord(resultData.item || result.item);
  const downloadPath = String(resultData.downloadUrl || result.downloadUrl || "").trim();
  const unsignedDownloadUrl = downloadPath.startsWith("http://") || downloadPath.startsWith("https://")
    ? downloadPath
    : `${baseUrl}${downloadPath}`;
  const downloadUrl = appendBridgeTokenToUrl(unsignedDownloadUrl, bridgeToken);

  return {
    payload,
    exportId: String(item.id || ""),
    downloadUrl,
    item
  };
}
