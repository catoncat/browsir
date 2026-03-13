import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCursorHelpWebProvider, handleWebChatRuntimeMessage } from "../web-chat-executor.browser";
import type { LlmResolvedRoute } from "../llm-provider";
import { CURSOR_HELP_WEB_API_KEY, CURSOR_HELP_WEB_BASE_URL } from "../../../shared/llm-provider-config";
import { CURSOR_HELP_REWRITE_STRATEGY, CURSOR_HELP_RUNTIME_VERSION } from "../../../shared/cursor-help-runtime-meta";

const CURSOR_HELP_SESSION_SLOT_STORAGE_KEY = "cursor_help_web.session_slots";

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
  const tabRemovedListeners: Array<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void> = [];
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
        senderKind: "react_chat_input_on_submit",
        pageRuntimeVersion: CURSOR_HELP_RUNTIME_VERSION,
        contentRuntimeVersion: CURSOR_HELP_RUNTIME_VERSION,
        runtimeExpectedVersion: CURSOR_HELP_RUNTIME_VERSION,
        rewriteStrategy: CURSOR_HELP_REWRITE_STRATEGY,
        runtimeMismatch: false
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
    update: vi.fn(async (tabId: number) => ({ id: tabId })),
    onRemoved: {
      addListener: vi.fn((listener: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void) => {
        tabRemovedListeners.push(listener);
      })
    }
  };
  (chrome as unknown as Record<string, unknown>).windows = {
    create: vi.fn(),
    update: vi.fn(async () => ({}))
  };
  (chrome as unknown as Record<string, unknown>).scripting = {
    executeScript: vi.fn(async () => [])
  };
  return {
    sendMessage,
    emitTabRemoved(tabId: number, windowId = 2) {
      for (const listener of tabRemovedListeners) {
        listener(tabId, {
          windowId,
          isWindowClosing: false
        });
      }
    }
  };
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

  it("repairs malformed JSON in tool protocol and still emits tool_calls", async () => {
    const provider = createCursorHelpWebProvider();
    const response = await provider.send({
      sessionId: "session-2-json-repair",
      step: 1,
      route: createRoute(),
      signal: new AbortController().signal,
      payload: {
        stream: true,
        messages: [{ role: "user", content: "继续填写输入框" }],
        tools: [
          {
            type: "function",
            function: {
              name: "fill_element_by_uid",
              description: "Fill an element by uid",
              parameters: {
                type: "object",
                properties: {
                  tabId: { type: "number" },
                  uid: { type: "string" },
                  value: { type: "string" },
                  forceFocus: { type: "boolean" },
                },
              },
            },
          },
        ],
        tool_choice: "auto",
      },
    });

    const requestId = getLastExecuteRequestId();
    expect(requestId).not.toBe("");

    const textPromise = readResponseText(response);
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "request_started",
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "sse_line",
      line: 'data: {"type":"text-delta","delta":"[TM_TOOL_CALL_START:fill1]\\nawait mcp.call(\\"fill_element_by_uid\\", {\\"tabId\\":543592833,\\"uid\\":\\"bn-2383\\",\\"value\\":\\"你理解\\"痛苦\\"、\\"美\\"、\\"死亡\\"这些概念时有什么不同？\\",\\"forceFocus\\":true})\\n[TM_TOOL_CALL_END:fill1]"}',
    });

    const text = await textPromise;
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"name":"fill_element_by_uid"');
    expect(text).toContain('\\"uid\\":\\"bn-2383\\"');
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it("withholds provisional text when the turn resolves to tool_calls", async () => {
    const provider = createCursorHelpWebProvider();
    const response = await provider.send({
      sessionId: "session-2b",
      step: 1,
      route: createRoute(),
      signal: new AbortController().signal,
      payload: {
        stream: true,
        messages: [{ role: "user", content: "Continue" }],
        tools: [
          {
            type: "function",
            function: {
              name: "scroll_page",
              description: "Scroll page",
              parameters: { type: "object", properties: { deltaY: { type: "number" } } }
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
      line: 'data: {"type":"text-delta","delta":"我已经看到回复了，现在继续找输入框。"}'
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "sse_line",
      line: 'data: {"type":"text-delta","delta":"\\n[TM_TOOL_CALL_START:call_scroll]\\nawait mcp.call(\\"scroll_page\\", {\\"deltaY\\":500})\\n[TM_TOOL_CALL_END:call_scroll]"}'
    });

    const text = await textPromise;
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"name":"scroll_page"');
    expect(text).not.toContain("我已经看到回复了");
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it("buffers plain text until stream_end when no tool protocol appears", async () => {
    const provider = createCursorHelpWebProvider();
    const response = await provider.send({
      sessionId: "session-2c",
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
      line: 'data: {"type":"text-delta","delta":"hello"}'
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "sse_line",
      line: 'data: {"type":"text-delta","delta":" world"}'
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      requestId,
      transportType: "stream_end"
    });

    const text = await textPromise;
    expect(text).toContain('"content":"hello world"');
    expect(text).toContain('"finish_reason":"stop"');
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

  it("rejects stale runtime version before execute", async () => {
    const sendMessage = (chrome.tabs as unknown as Record<string, unknown>).sendMessage as ReturnType<typeof vi.fn>;
    (chrome.windows as unknown as Record<string, unknown>).create = vi.fn(async () => ({
      tabs: [
        {
          id: 11,
          status: "complete",
          url: "https://cursor.com/help",
          windowId: 3
        }
      ]
    }));
    sendMessage.mockImplementation(async (_tabId: number, message: Record<string, unknown>) => {
      const type = String(message.type || "").trim();
      if (type === "webchat.inspect") {
        return {
          ok: true,
          pageHookReady: true,
          fetchHookReady: true,
          senderReady: true,
          canExecute: false,
          url: "https://cursor.com/help",
          selectedModel: "Sonnet 4.6",
          availableModels: ["Sonnet 4.6"],
          senderKind: "react_chat_input_on_submit",
          pageRuntimeVersion: "stale-runtime",
          contentRuntimeVersion: CURSOR_HELP_RUNTIME_VERSION,
          runtimeExpectedVersion: CURSOR_HELP_RUNTIME_VERSION,
          rewriteStrategy: CURSOR_HELP_REWRITE_STRATEGY,
          runtimeMismatch: true,
          runtimeMismatchReason: "Cursor Help 页面运行时版本不一致。page=stale-runtime expected=current"
        };
      }
      if (type === "webchat.execute" || type === "webchat.abort") {
        return { ok: true };
      }
      throw new Error(`unexpected tab message: ${type}`);
    });

    const provider = createCursorHelpWebProvider();
    await expect(
      provider.send({
        sessionId: "stale-runtime-session",
        step: 1,
        route: createRoute(),
        signal: new AbortController().signal,
        payload: {
          stream: true,
          messages: [{ role: "user", content: "Say hello" }],
          tools: [],
          tool_choice: "auto"
        }
      })
    ).rejects.toThrow("Cursor Help 运行时版本不一致");

    expect(
      sendMessage.mock.calls.some(
        ([, message]) => String((message as Record<string, unknown>).type || "") === "webchat.execute"
      )
    ).toBe(false);
  });

  it("clears bound session slot when the Cursor Help tab closes", async () => {
    const { emitTabRemoved } = buildChromeMock();
    createCursorHelpWebProvider();

    await chrome.storage.local.set({
      [CURSOR_HELP_SESSION_SLOT_STORAGE_KEY]: {
        "session-stale": {
          sessionId: "session-stale",
          tabId: 7,
          windowId: 2,
          lastKnownUrl: "https://cursor.com/help",
          lastReadyAt: 1
        },
        "session-keep": {
          sessionId: "session-keep",
          tabId: 9,
          windowId: 2,
          lastKnownUrl: "https://cursor.com/help",
          lastReadyAt: 1
        }
      }
    });

    emitTabRemoved(7);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = await chrome.storage.local.get(CURSOR_HELP_SESSION_SLOT_STORAGE_KEY);
    expect(stored[CURSOR_HELP_SESSION_SLOT_STORAGE_KEY]).toEqual({
      "session-keep": {
        sessionId: "session-keep",
        tabId: 9,
        windowId: 2,
        lastKnownUrl: "https://cursor.com/help",
        lastReadyAt: 1
      }
    });
  });

  it("drops the stale slot binding after startup timeout before any request_started event", async () => {
    vi.useFakeTimers();
    try {
      buildChromeMock();
      const provider = createCursorHelpWebProvider();

      await chrome.storage.local.set({
        [CURSOR_HELP_SESSION_SLOT_STORAGE_KEY]: {
          "session-stale": {
            sessionId: "session-stale",
            tabId: 7,
            windowId: 2,
            lastKnownUrl: "https://cursor.com/help",
            lastReadyAt: 1
          }
        }
      });

      const response = await provider.send({
        sessionId: "session-stale",
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

      const textErrorPromise = readResponseText(response).catch((error) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      const error = await textErrorPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("网页 provider 请求未启动");
      await Promise.resolve();
      await Promise.resolve();

      const stored = await chrome.storage.local.get(CURSOR_HELP_SESSION_SLOT_STORAGE_KEY);
      expect(stored[CURSOR_HELP_SESSION_SLOT_STORAGE_KEY]).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});
