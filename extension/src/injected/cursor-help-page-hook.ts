import type { CursorHelpRequestBody, CursorHelpTransportEventType } from "../shared/cursor-help-protocol";

const PAGE_SOURCE = "bbl-cursor-help-page";
const CONTENT_SOURCE = "bbl-cursor-help-content";
const PAGE_HOOK_READY_ATTR = "data-bbl-cursor-help-page-ready";
const PAGE_HOOK_INSTALLED_FLAG = "__bblCursorHelpPageHookInstalled";

if (!(window as typeof window & Record<string, unknown>)[PAGE_HOOK_INSTALLED_FLAG]) {
  (window as typeof window & Record<string, unknown>)[PAGE_HOOK_INSTALLED_FLAG] = true;

type JsonRecord = Record<string, unknown>;

interface ActiveExecution {
  requestId: string;
  controller: AbortController;
}

let activeExecution: ActiveExecution | null = null;

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

function postTransportEvent(payload: Record<string, unknown>): void {
  window.postMessage(
    {
      source: PAGE_SOURCE,
      type: "WEBCHAT_TRANSPORT_EVENT",
      payload
    },
    window.location.origin
  );
}

function emitTransportEvent(
  requestId: string,
  transportType: CursorHelpTransportEventType,
  extra: Record<string, unknown> = {}
): void {
  postTransportEvent({
    requestId,
    transportType,
    ...extra
  });
}

function resolveRequestUrl(requestUrl: string): string {
  const normalized = String(requestUrl || "").trim() || "/api/chat";
  return new URL(normalized, window.location.origin).toString();
}

function parseRequestBody(value: unknown): CursorHelpRequestBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as CursorHelpRequestBody;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 240);
  } catch {
    return "";
  }
}

async function forwardCursorHelpStream(stream: ReadableStream<Uint8Array>, requestId: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineBreak = buffer.indexOf("\n");
    while (lineBreak >= 0) {
      const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
      buffer = buffer.slice(lineBreak + 1);
      emitTransportEvent(requestId, "sse_line", { line });
      lineBreak = buffer.indexOf("\n");
    }
  }

  const tail = buffer + decoder.decode();
  if (tail) {
    for (const line of tail.split(/\r?\n/)) {
      emitTransportEvent(requestId, "sse_line", { line });
    }
  }
  emitTransportEvent(requestId, "stream_end");
}

async function executeCursorHelpRequest(requestId: string, requestUrl: string, requestBody: CursorHelpRequestBody): Promise<void> {
  const controller = new AbortController();
  activeExecution = {
    requestId,
    controller
  };

  try {
    const targetUrl = resolveRequestUrl(requestUrl);
    logToContent("execute.fetch", "running", `POST ${targetUrl}`);
    emitTransportEvent(requestId, "request_started", { url: targetUrl });

    const response = await fetch(targetUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    const contentType = String(response.headers.get("content-type") || "").trim();
    logToContent("execute.fetch", response.ok ? "done" : "failed", `${response.status} ${contentType || "(empty)"}`);
    if (!response.ok) {
      emitTransportEvent(requestId, "http_error", {
        status: response.status,
        contentType,
        bodyText: await readResponseText(response)
      });
      return;
    }

    if (!contentType.toLowerCase().includes("text/event-stream") || !response.body) {
      emitTransportEvent(requestId, "invalid_response", {
        status: response.status,
        contentType,
        bodyText: await readResponseText(response)
      });
      return;
    }

    await forwardCursorHelpStream(response.body, requestId);
  } catch (error) {
    emitTransportEvent(requestId, "network_error", {
      error: error instanceof Error ? error.message : String(error)
    });
    logToContent("execute.fetch", "failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (activeExecution?.requestId === requestId) {
      activeExecution = null;
    }
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== CONTENT_SOURCE || !data.type) return;

  if (data.type === "WEBCHAT_EXECUTE") {
    const payload = toRecord(data.payload);
    const requestId = String(payload.requestId || "").trim();
    const requestUrl = String(payload.requestUrl || "").trim() || "/api/chat";
    const requestBody = parseRequestBody(payload.requestBody);
    if (!requestId || !requestBody) {
      logToContent("execute", "failed", "执行请求缺少 requestId 或 requestBody");
      emitTransportEvent(requestId || "unknown", "network_error", {
        error: "执行请求缺少 requestId 或 requestBody"
      });
      return;
    }
    logToContent("execute", "done", `收到 transport execute requestId=${requestId}`);
    void executeCursorHelpRequest(requestId, requestUrl, requestBody);
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
logToContent("boot", "done", "cursor help page hook 已安装（transport mode）");
window.postMessage(
  {
    source: PAGE_SOURCE,
    type: "WEBCHAT_PAGE_READY",
    payload: null
  },
  window.location.origin
);
}
