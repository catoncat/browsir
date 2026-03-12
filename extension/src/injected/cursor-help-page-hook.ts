const PAGE_SOURCE = "bbl-cursor-help-page";
const CONTENT_SOURCE = "bbl-cursor-help-content";
const PAGE_HOOK_READY_ATTR = "data-bbl-cursor-help-page-ready";
const PAGE_HOOK_INSTALLED_FLAG = "__bblCursorHelpPageHookInstalled";

if (!(window as typeof window & Record<string, unknown>)[PAGE_HOOK_INSTALLED_FLAG]) {
  (window as typeof window & Record<string, unknown>)[PAGE_HOOK_INSTALLED_FLAG] = true;

type JsonRecord = Record<string, unknown>;

interface WebToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ParsedToolProtocol {
  toolCalls: WebToolCall[];
  matchedText: string;
}

interface ActiveExecution {
  requestId: string;
  controller: AbortController;
}

let activeExecution: ActiveExecution | null = null;

const MODEL_ALIASES: Array<{ match: RegExp; apiModel: string }> = [
  { match: /anthropic\/claude-sonnet-4\.6|claude-sonnet-4\.6|sonnet 4\.6/i, apiModel: "anthropic/claude-sonnet-4.6" },
  { match: /anthropic\/claude-sonnet-4|claude-sonnet-4|sonnet 4/i, apiModel: "anthropic/claude-sonnet-4" },
  { match: /anthropic\/claude-opus-4\.1|claude-opus-4\.1|opus 4\.1/i, apiModel: "anthropic/claude-opus-4.1" },
  { match: /anthropic\/claude-opus-4|claude-opus-4|opus 4/i, apiModel: "anthropic/claude-opus-4" },
  { match: /google\/gemini-2\.5-pro|gemini-2\.5-pro|gemini 2\.5 pro/i, apiModel: "google/gemini-2.5-pro" },
  { match: /google\/gemini-2\.5-flash|gemini-2\.5-flash|gemini 2\.5 flash/i, apiModel: "google/gemini-2.5-flash" },
  { match: /openai\/gpt-5|gpt-5/i, apiModel: "openai/gpt-5" },
  { match: /openai\/gpt-4\.1|gpt-4\.1/i, apiModel: "openai/gpt-4.1" },
  { match: /openai\/o3|o3/i, apiModel: "openai/o3" },
  { match: /openai\/o1|o1/i, apiModel: "openai/o1" }
];

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function logToContent(step: string, status: "running" | "done" | "failed", detail: string): void {
  window.postMessage(
    {
      source: PAGE_SOURCE,
      type: "PAGE_HOOK_LOG",
      payload: {
        step,
        status,
        detail
      }
    },
    window.location.origin
  );
}

function postToContent(payload: Record<string, unknown>): void {
  window.postMessage(
    {
      source: PAGE_SOURCE,
      type: "WEBCHAT_EVENT",
      payload
    },
    window.location.origin
  );
}

function parseToolProtocolFromText(source: unknown): ParsedToolProtocol | null {
  const text = String(source || "");
  if (!text) return null;
  const pattern = /\[TM_TOOL_CALL_START:([^\]\n]+)\]([\s\S]*?)\[TM_TOOL_CALL_END:\1\]/g;
  const toolCalls: WebToolCall[] = [];
  const matchedParts: string[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(text))) {
    const callId = String(match[1] || "").trim();
    const body = String(match[2] || "").trim();
    const invokeMatch = body.match(/await\s+mcp\.call\(\s*(['"])([^'"]+)\1\s*,\s*([\s\S]+?)\s*\)\s*;?\s*$/);
    if (!invokeMatch) continue;
    const toolName = String(invokeMatch[2] || "").trim();
    const rawArgs = String(invokeMatch[3] || "").trim();
    if (!toolName || !rawArgs) continue;
    try {
      const parsedArgs = JSON.parse(rawArgs);
      toolCalls.push({
        id: callId || `tool_${toolCalls.length + 1}`,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(parsedArgs)
        }
      });
      matchedParts.push(match[0]);
    } catch {
      continue;
    }
  }

  if (toolCalls.length <= 0) return null;
  return {
    toolCalls,
    matchedText: matchedParts.join("\n")
  };
}

function normalizeModelText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function resolveApiModel(requestedModel: string, detectedModel: string): string {
  const candidates = [requestedModel, detectedModel];
  for (const candidate of candidates) {
    const normalized = normalizeModelText(candidate);
    if (!normalized || normalized.toLowerCase() === "auto") continue;
    for (const alias of MODEL_ALIASES) {
      if (alias.match.test(normalized)) {
        return alias.apiModel;
      }
    }
    if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(normalized)) {
      return normalized;
    }
  }
  return "anthropic/claude-sonnet-4.6";
}

function makeRandomId(length = 16): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function buildCursorHelpRequestBody(compiledPrompt: string, requestedModel: string, detectedModel: string): JsonRecord {
  return {
    context: [],
    model: resolveApiModel(requestedModel, detectedModel),
    id: makeRandomId(16),
    messages: [
      {
        parts: [
          {
            type: "text",
            text: compiledPrompt
          }
        ],
        id: makeRandomId(16),
        role: "user"
      }
    ],
    trigger: "submit-message"
  };
}

function extractTextDelta(packet: JsonRecord): string {
  return packet.type === "text-delta" && typeof packet.delta === "string" ? packet.delta : "";
}

function classifyHttpError(status: number, bodyText: string): string {
  const detail = bodyText ? ` ${bodyText}` : "";
  if (status === 401) return `Cursor Help 未登录或登录态失效。请先在 cursor.com 登录。${detail}`.trim();
  if (status === 403) return `Cursor Help 当前账号无权访问该请求。${detail}`.trim();
  if (status === 404) return `Cursor Help /api/chat 不可用。${detail}`.trim();
  if (status === 429) return `Cursor Help 请求过于频繁，已被限流。${detail}`.trim();
  if (status >= 500) return `Cursor Help 服务暂时异常 (${status})。${detail}`.trim();
  return detail ? `/api/chat 请求失败: ${status} ${bodyText}` : `/api/chat 请求失败: ${status}`;
}

async function observeCursorHelpSse(stream: ReadableStream<Uint8Array>, requestId: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aggregateText = "";
  let toolCallSent = false;
  let finished = false;

  const emitDone = () => {
    if (finished) return;
    finished = true;
    postToContent({
      eventType: "webchat.done",
      requestId
    });
  };

  const flushLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      if (data === "[DONE]") emitDone();
      return;
    }

    let parsed: JsonRecord = {};
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (parsed.type === "error") {
      postToContent({
        eventType: "webchat.error",
        requestId,
        error: String(parsed.errorText || parsed.message || "Cursor Help SSE error")
      });
      return;
    }

    const delta = extractTextDelta(parsed);
    if (delta && !toolCallSent) {
      aggregateText += delta;
      postToContent({
        eventType: "webchat.delta",
        requestId,
        text: delta
      });
    }

    if (!toolCallSent) {
      const protocol = parseToolProtocolFromText(aggregateText);
      if (protocol && protocol.toolCalls.length > 0) {
        toolCallSent = true;
        postToContent({
          eventType: "webchat.tool_call_detected",
          requestId,
          toolCalls: protocol.toolCalls
        });
      }
    }

    if (parsed.type === "finish") {
      emitDone();
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak >= 0) {
        const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
        buffer = buffer.slice(lineBreak + 1);
        flushLine(line);
        lineBreak = buffer.indexOf("\n");
      }
    }
    const tail = buffer + decoder.decode();
    if (tail.trim()) {
      for (const line of tail.split(/\r?\n/)) flushLine(line);
    }
    emitDone();
  } catch (error) {
    postToContent({
      eventType: "webchat.error",
      requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function executeCursorHelpRequest(requestId: string, compiledPrompt: string, requestedModel: string, detectedModel: string): Promise<void> {
  const controller = new AbortController();
  activeExecution = {
    requestId,
    controller
  };

  const requestBody = buildCursorHelpRequestBody(compiledPrompt, requestedModel, detectedModel);
  const apiModel = String(requestBody.model || "");
  logToContent("execute.fetch", "running", `POST /api/chat model=${apiModel}`);
  postToContent({
    eventType: "webchat.request_started",
    requestId,
    url: `${window.location.origin}/api/chat`
  });

  const response = await fetch("/api/chat", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify(requestBody),
    signal: controller.signal
  });

  const contentType = String(response.headers.get("content-type") || "").trim() || "(empty)";
  logToContent("execute.fetch", response.ok ? "done" : "failed", `/api/chat -> ${response.status} ${contentType}`);
  if (!response.ok) {
    activeExecution = null;
    let errorText = "";
    try {
      errorText = (await response.text()).slice(0, 240);
    } catch {
      errorText = "";
    }
    throw new Error(classifyHttpError(response.status, errorText));
  }
  if (!contentType.toLowerCase().includes("text/event-stream") || !response.body) {
    activeExecution = null;
    throw new Error(`Cursor Help 返回非 SSE: ${contentType}`);
  }

  await observeCursorHelpSse(response.body, requestId);
  activeExecution = null;
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== CONTENT_SOURCE || !data.type) return;

  if (data.type === "WEBCHAT_EXECUTE") {
    const payload = toRecord(data.payload);
    const requestId = String(payload.requestId || "").trim();
    const compiledPrompt = String(payload.compiledPrompt || "");
    const requestedModel = String(payload.requestedModel || "").trim();
    const detectedModel = String(payload.detectedModel || "").trim();
    logToContent("execute", "done", `收到执行请求 requestId=${requestId}`);
    void executeCursorHelpRequest(requestId, compiledPrompt, requestedModel, detectedModel).catch((error) => {
      activeExecution = null;
      postToContent({
        eventType: "webchat.error",
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
      logToContent("execute.fetch", "failed", error instanceof Error ? error.message : String(error));
    });
    return;
  }

  if (data.type === "WEBCHAT_ABORT") {
    const payload = toRecord(data.payload);
    const requestId = String(payload.requestId || "").trim();
    if (activeExecution?.requestId === requestId) {
      activeExecution.controller.abort();
      activeExecution = null;
    }
    logToContent("abort", "done", `收到中止请求 requestId=${requestId}`);
  }
});

document.documentElement?.setAttribute(PAGE_HOOK_READY_ATTR, "1");
logToContent("boot", "done", "cursor help page hook 已安装（direct-api mode）");
window.postMessage(
  {
    source: PAGE_SOURCE,
    type: "WEBCHAT_PAGE_READY",
    payload: null
  },
  window.location.origin
);
}
