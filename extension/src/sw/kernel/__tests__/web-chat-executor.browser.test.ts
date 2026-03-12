import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCursorHelpWebProvider, handleWebChatRuntimeMessage } from "../web-chat-executor.browser";
import type { LlmResolvedRoute } from "../llm-provider";
import { CURSOR_HELP_WEB_API_KEY, CURSOR_HELP_WEB_BASE_URL } from "../../../shared/llm-provider-config";

function createRoute(): LlmResolvedRoute {
  return {
    profile: "cursor-help",
    provider: "cursor_help_web",
    llmBase: CURSOR_HELP_WEB_BASE_URL,
    llmKey: CURSOR_HELP_WEB_API_KEY,
    llmModel: "auto",
    providerOptions: {
      targetTabId: 7,
      targetSite: "cursor_help"
    },
    llmTimeoutMs: 120000,
    llmRetryMaxAttempts: 1,
    llmMaxRetryDelayMs: 60000,
    role: "worker",
    escalationPolicy: "upgrade_only",
    orderedProfiles: ["cursor-help"],
    fromLegacy: false
  };
}

function buildChromeMock() {
  const sendMessage = vi.fn(async (_tabId: number, message: Record<string, unknown>) => {
    const type = String(message.type || "").trim();
    if (type === "webchat.inspect") {
      return {
        ok: true,
        pageHookReady: true,
        fetchHookReady: true,
        senderReady: true,
        canExecute: true,
        url: "https://cursor.com/help",
        selectedModel: "Sonnet 4.6",
        availableModels: ["Sonnet 4.6"],
        senderKind: "react_chat_input_on_submit"
      };
    }
    if (type === "webchat.execute" || type === "webchat.abort") {
      return { ok: true };
    }
    throw new Error(`unexpected tab message: ${type}`);
  });

  (chrome as unknown as Record<string, unknown>).tabs = {
    get: vi.fn(async (tabId: number) => ({
      id: tabId,
      status: "complete",
      url: "https://cursor.com/help",
      windowId: 2
    })),
    query: vi.fn(async () => []),
    sendMessage,
    update: vi.fn(async (tabId: number) => ({ id: tabId }))
  };
  (chrome as unknown as Record<string, unknown>).windows = {
    create: vi.fn(),
    update: vi.fn(async () => ({}))
  };
  (chrome as unknown as Record<string, unknown>).scripting = {
    executeScript: vi.fn(async () => [])
  };
  return { sendMessage };
}

async function readResponseText(response: Response): Promise<string> {
  return await new Response(response.body).text();
}

function getLastExecuteRequestId(): string {
  const sendMessage = (chrome.tabs as unknown as Record<string, unknown>).sendMessage as ReturnType<typeof vi.fn>;
  const executeCall = sendMessage.mock.calls.find(
    ([, message]) => String((message as Record<string, unknown>).type || "") === "webchat.execute"
  );
  return String(((executeCall?.[1] as Record<string, unknown>) || {}).requestId || "");
}

describe("web-chat-executor.browser", () => {
  beforeEach(() => {
    buildChromeMock();
  });

  it("parses transport SSE lines in SW and emits final text stream", async () => {
    const provider = createCursorHelpWebProvider();
    const response = await provider.send({
      sessionId: "session-1",
      step: 1,
      route: createRoute(),
      signal: new AbortController().signal,
      payload: {
        stream: true,
        messages: [{ role: "user", content: "Say hello" }],
        tools: [],
        tool_choice: "auto"
      }
    });

    const textPromise = readResponseText(response);
    const requestId = getLastExecuteRequestId();
    expect(requestId).not.toBe("");
    const sendMessage = (chrome.tabs as unknown as Record<string, unknown>).sendMessage as ReturnType<typeof vi.fn>;
    const executeCall = sendMessage.mock.calls.find(
      ([, message]) => String((message as Record<string, unknown>).type || "") === "webchat.execute"
    );
    expect(((executeCall?.[1] as Record<string, unknown>) || {}).compiledPrompt).toBeTypeOf("string");
    expect(((executeCall?.[1] as Record<string, unknown>) || {}).latestUserPrompt).toBe("Say hello");
    expect(((executeCall?.[1] as Record<string, unknown>) || {}).requestBody).toBeUndefined();

    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "request_started"
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "sse_line",
      line: 'data: {"type":"text-delta","delta":"hello"}'
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "stream_end"
    });

    const text = await textPromise;
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"finish_reason":"stop"');
  });

  it("detects tool protocol from transport SSE lines inside SW", async () => {
    const provider = createCursorHelpWebProvider();
    const response = await provider.send({
      sessionId: "session-2",
      step: 1,
      route: createRoute(),
      signal: new AbortController().signal,
      payload: {
        stream: true,
        messages: [{ role: "user", content: "Search docs" }],
        tools: [
          {
            type: "function",
            function: {
              name: "search_docs",
              description: "Search docs",
              parameters: { type: "object", properties: { q: { type: "string" } } }
            }
          }
        ],
        tool_choice: "auto"
      }
    });

    const requestId = getLastExecuteRequestId();
    expect(requestId).not.toBe("");

    const textPromise = readResponseText(response);
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "request_started"
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "sse_line",
      line: 'data: {"type":"text-delta","delta":"[TM_TOOL_CALL_START:call_1]\\nawait mcp.call(\\"search_docs\\", {\\"q\\":\\"runtime router\\"})\\n[TM_TOOL_CALL_END:call_1]"}'
    });

    const text = await textPromise;
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"name":"search_docs"');
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it("locks execution by session instead of only by tab singleton", async () => {
    const provider = createCursorHelpWebProvider();
    const first = await provider.send({
      sessionId: "session-a",
      step: 1,
      route: createRoute(),
      signal: new AbortController().signal,
      payload: {
        stream: true,
        messages: [{ role: "user", content: "Say hello" }],
        tools: [],
        tool_choice: "auto"
      }
    });

    await expect(
      provider.send({
        sessionId: "session-a",
        step: 2,
        route: createRoute(),
        signal: new AbortController().signal,
        payload: {
          stream: true,
          messages: [{ role: "user", content: "Again" }],
          tools: [],
          tool_choice: "auto"
        }
      })
    ).rejects.toThrow("会话 session-a 已有执行中的网页 provider 请求");

    const requestId = getLastExecuteRequestId();
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "request_started"
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "stream_end"
    });
    await readResponseText(first);
  });
});
