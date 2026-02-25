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
      if (mode === "compaction") {
        lines.push(`LLM 摘要请求 · mode=${summaryMode || "history"} · model=${String(payload.model || "")}`);
      } else {
        lines.push(`LLM 请求 · model=${String(payload.model || "")}`);
      }
      continue;
    }
    if (type === "llm.response.parsed") {
      lines.push(`LLM 解析 · toolCalls=${String(payload.toolCalls || 0)}`);
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
      point.data = summarizeLlmRequestPayload(payload);
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
        hasText: payload.hasText === true
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
        preview: clipText(payload.preview, 1000)
      };
      output.push(point);
      continue;
    }

    if (event.type === "step_execute") {
      point.data = {
        mode: String(payload.mode || ""),
        action: String(payload.action || "")
      };
      output.push(point);
      continue;
    }

    if (event.type === "step_execute_result") {
      point.data = {
        ok: payload.ok === true,
        modeUsed: String(payload.modeUsed || ""),
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
    "[[BBL_DIAGNOSTIC_V2]]",
    JSON.stringify(payload, null, 2),
    "[[/BBL_DIAGNOSTIC_V2]]"
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
    "llm.response.parsed"
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
    } else if (event.type === "llm.response.parsed") {
      row.step = toPositiveInt(payload.step);
      row.toolCalls = toPositiveInt(payload.toolCalls);
      row.hasText = payload.hasText === true;
    }

    rows.push(row);
  }

  return rows.slice(-Math.max(1, limit));
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
  const events = normalizeStepEvents(stepStream);

  const timeline = normalizeStepTimeline(stepStream, options.timelineLimit ?? 24);
  const lastError = findLastError(stepStream);
  const recentEvents = buildRecentEventsSummary(options.recentEvents || [], events);
  const loopRuns = buildLoopRuns(events);
  const llmTrace = buildLlmTrace(events, options.llmLimit ?? 120);
  const toolTrace = buildToolTrace(events, options.toolLimit ?? 140);
  const rawEventTail = buildRawEventTail(events, options.eventLimit ?? 80);
  const eventTypeCounts = buildEventTypeCounts(events);
  const conversationTail = buildConversationTail(messages, options.conversationTailLimit ?? 14);
  const agentDecisionTrace = buildAgentDecisionTrace(events, 100);
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
    schemaVersion: "bbl.diagnostic.v2",
    generatedAt: new Date().toISOString(),
    sessionId: sessionId || String(dumpRecord.sessionId || ""),
    config: {
      bridgeUrl: String(toRecord(config).bridgeUrl || ""),
      llmApiBase: String(toRecord(config).llmApiBase || ""),
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
      lastError
    },
    timeline,
    recentEvents,
    eventTypeCounts,
    agent: {
      parentSessionId: String(conversationView.parentSessionId || ""),
      forkedFrom: sanitizeValue(conversationView.forkedFrom),
      runtimeState: sanitizeValue(runtime),
      lastStatus: sanitizeValue(conversationView.lastStatus),
      loopRuns,
      decisionTrace: agentDecisionTrace,
      conversationTail
    },
    llm: {
      skipped: llmSkipped,
      trace: llmTrace
    },
    tools: {
      trace: toolTrace
    },
    rawEventTail,
    debug: {
      entryCount: Number(dumpRecord.entryCount || 0),
      stepStreamCount: events.length,
      stepStreamMeta: sanitizeValue(stepStreamMeta),
      globalTailCount: Array.isArray(dumpRecord.globalTail) ? dumpRecord.globalTail.length : 0
    }
  };

  return {
    payload,
    text: buildDiagnosticsText(payload)
  };
}
