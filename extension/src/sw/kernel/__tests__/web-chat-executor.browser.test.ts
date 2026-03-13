import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCursorHelpWebProvider, handleWebChatRuntimeMessage } from "../web-chat-executor.browser";
import type { LlmResolvedRoute } from "../llm-provider";
import {
  parseHostedChatTransportEvent,
  type HostedChatTransportEvent,
} from "../../../shared/cursor-help-web-shared";
import { CURSOR_HELP_REWRITE_STRATEGY, CURSOR_HELP_RUNTIME_VERSION } from "../../../shared/cursor-help-runtime-meta";

const CURSOR_HELP_SESSION_SLOT_STORAGE_KEY = "cursor_help_web.session_slots";

function createRoute(): LlmResolvedRoute {
  return {
    profile: "cursor-help",
    provider: "cursor_help_web",
    runtimeKind: "hosted_chat",
    llmBase: "",
    llmKey: "",
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

async function readHostedEvents(response: Response): Promise<HostedChatTransportEvent[]> {
  const text = await readResponseText(response);
  return text
    .split(/\r?\n/)
    .map((line) => parseHostedChatTransportEvent(line))
    .filter((item): item is HostedChatTransportEvent => Boolean(item));
}

function getLastExecuteRequestId(): string {
  const sendMessage = (chrome.tabs as unknown as Record<string, unknown>).sendMessage as ReturnType<typeof vi.fn>;
  const executeCall = sendMessage.mock.calls.find(
    ([, message]) => String((message as Record<string, unknown>).type || "") === "webchat.execute"
  );
  return String(((executeCall?.[1] as Record<string, unknown>) || {}).requestId || "");
}

describe("web-chat-executor.browser", () => {
  beforeEach(async () => {
    buildChromeMock();
    await chrome.storage.local.clear();
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

    const eventsPromise = readHostedEvents(response);
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
      envelope: {
        type: "hosted_chat.debug",
        requestId,
        stage: "request_started",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.stream_text_delta",
        requestId,
        deltaText: "hello",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.turn_resolved",
        requestId,
        result: {
          assistantText: "hello",
          toolCalls: [],
          finishReason: "stop",
          meta: {
            assistantTextLength: 5
          }
        }
      }
    });

    const events = await eventsPromise;
    expect(events.map((item) => item.type)).toEqual([
      "hosted_chat.debug",
      "hosted_chat.stream_text_delta",
      "hosted_chat.turn_resolved",
    ]);
    const resolved = events[2];
    expect(resolved.type).toBe("hosted_chat.turn_resolved");
    if (resolved.type !== "hosted_chat.turn_resolved") return;
    expect(resolved.result.assistantText).toBe("hello");
    expect(resolved.result.finishReason).toBe("stop");
  });

  it("emits hosted transport events for tool handoff", async () => {
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

    const eventsPromise = readHostedEvents(response);
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.debug",
        requestId,
        stage: "request_started",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.stream_text_delta",
        requestId,
        deltaText:
          '[TM_TOOL_CALL_START:call_1]\nawait mcp.call("search_docs", {"q":"runtime router"})\n[TM_TOOL_CALL_END:call_1]',
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.tool_call_detected",
        requestId,
        assistantText: "",
        toolCalls: [
          {
            callId: "call_1",
            toolName: "search_docs",
            rawArgumentsText: '{"q":"runtime router"}',
            parsedArguments: { q: "runtime router" },
            sourceRange: { start: 0, end: 97 },
            leadingAssistantText: "",
            trailingAssistantText: "",
          },
        ],
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.turn_resolved",
        requestId,
        result: {
          assistantText: "",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "search_docs",
                arguments: '{"q":"runtime router"}',
              },
            },
          ],
          finishReason: "tool_calls",
          meta: {}
        }
      }
    });

    const events = await eventsPromise;
    expect(events.map((item) => item.type)).toEqual([
      "hosted_chat.debug",
      "hosted_chat.stream_text_delta",
      "hosted_chat.tool_call_detected",
      "hosted_chat.turn_resolved",
    ]);
    const toolDetected = events[2];
    expect(toolDetected.type).toBe("hosted_chat.tool_call_detected");
    if (toolDetected.type !== "hosted_chat.tool_call_detected") return;
    expect(toolDetected.toolCalls[0]?.toolName).toBe("search_docs");
    const resolved = events[3];
    expect(resolved.type).toBe("hosted_chat.turn_resolved");
    if (resolved.type !== "hosted_chat.turn_resolved") return;
    expect(resolved.result.finishReason).toBe("tool_calls");
    expect(resolved.result.toolCalls[0]?.function.name).toBe("search_docs");
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

    const eventsPromise = readHostedEvents(response);
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.debug",
        requestId,
        stage: "request_started",
      },
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.stream_text_delta",
        requestId,
        deltaText:
          '[TM_TOOL_CALL_START:fill1]\nawait mcp.call("fill_element_by_uid", {"tabId":543592833,"uid":"bn-2383","value":"你理解"痛苦"、"美"、"死亡"这些概念时有什么不同？","forceFocus":true})\n[TM_TOOL_CALL_END:fill1]',
      },
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.tool_call_detected",
        requestId,
        assistantText: "",
        toolCalls: [
          {
            callId: "fill1",
            toolName: "fill_element_by_uid",
            rawArgumentsText:
              '{"tabId":543592833,"uid":"bn-2383","value":"你理解"痛苦"、"美"、"死亡"这些概念时有什么不同？","forceFocus":true}',
            parsedArguments: {
              tabId: 543592833,
              uid: "bn-2383",
              value: '你理解"痛苦"、"美"、"死亡"这些概念时有什么不同？',
              forceFocus: true,
            },
            sourceRange: { start: 0, end: 0 },
            leadingAssistantText: "",
            trailingAssistantText: "",
          },
        ],
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.turn_resolved",
        requestId,
        result: {
          assistantText: "",
          toolCalls: [
            {
              id: "fill1",
              type: "function",
              function: {
                name: "fill_element_by_uid",
                arguments:
                  '{"tabId":543592833,"uid":"bn-2383","value":"你理解\\"痛苦\\"、\\"美\\"、\\"死亡\\"这些概念时有什么不同？","forceFocus":true}',
              },
            },
          ],
          finishReason: "tool_calls",
          meta: {}
        }
      }
    });

    const events = await eventsPromise;
    const resolved = events.at(-1);
    expect(resolved?.type).toBe("hosted_chat.turn_resolved");
    if (!resolved || resolved.type !== "hosted_chat.turn_resolved") return;
    expect(resolved.result.toolCalls[0]?.function.name).toBe(
      "fill_element_by_uid",
    );
    expect(resolved.result.toolCalls[0]?.function.arguments).toContain(
      '"uid":"bn-2383"',
    );
    expect(resolved.result.finishReason).toBe("tool_calls");
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

    const eventsPromise = readHostedEvents(response);
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.debug",
        requestId,
        stage: "request_started",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.stream_text_delta",
        requestId,
        deltaText: "我已经看到回复了，现在继续找输入框。",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.stream_text_delta",
        requestId,
        deltaText:
          '\n[TM_TOOL_CALL_START:call_scroll]\nawait mcp.call("scroll_page", {"deltaY":500})\n[TM_TOOL_CALL_END:call_scroll]',
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.tool_call_detected",
        requestId,
        assistantText: "我已经看到回复了，现在继续找输入框。",
        toolCalls: [
          {
            callId: "call_scroll",
            toolName: "scroll_page",
            rawArgumentsText: '{"deltaY":500}',
            parsedArguments: { deltaY: 500 },
            sourceRange: { start: 0, end: 0 },
            leadingAssistantText: "我已经看到回复了，现在继续找输入框。",
            trailingAssistantText: "",
          },
        ],
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.turn_resolved",
        requestId,
        result: {
          assistantText: "我已经看到回复了，现在继续找输入框。",
          toolCalls: [
            {
              id: "call_scroll",
              type: "function",
              function: {
                name: "scroll_page",
                arguments: '{"deltaY":500}',
              },
            },
          ],
          finishReason: "tool_calls",
          meta: {}
        }
      }
    });

    const events = await eventsPromise;
    const resolved = events.at(-1);
    expect(resolved?.type).toBe("hosted_chat.turn_resolved");
    if (!resolved || resolved.type !== "hosted_chat.turn_resolved") return;
    expect(resolved.result.toolCalls[0]?.function.name).toBe("scroll_page");
    expect(resolved.result.assistantText).toBe(
      "我已经看到回复了，现在继续找输入框。",
    );
    expect(resolved.result.finishReason).toBe("tool_calls");
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

    const eventsPromise = readHostedEvents(response);
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.debug",
        requestId,
        stage: "request_started",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.stream_text_delta",
        requestId,
        deltaText: "hello",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.stream_text_delta",
        requestId,
        deltaText: " world",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.turn_resolved",
        requestId,
        result: {
          assistantText: "hello world",
          toolCalls: [],
          finishReason: "stop",
          meta: {}
        }
      }
    });

    const events = await eventsPromise;
    const resolved = events.at(-1);
    expect(resolved?.type).toBe("hosted_chat.turn_resolved");
    if (!resolved || resolved.type !== "hosted_chat.turn_resolved") return;
    expect(resolved.result.assistantText).toBe("hello world");
    expect(resolved.result.finishReason).toBe("stop");
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
      envelope: {
        type: "hosted_chat.debug",
        requestId,
        stage: "request_started",
      }
    });
    await handleWebChatRuntimeMessage({
      type: "webchat.transport",
      envelope: {
        type: "hosted_chat.turn_resolved",
        requestId,
        result: {
          assistantText: "",
          toolCalls: [],
          finishReason: "stop",
          meta: {}
        }
      }
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
    const realSetTimeout = globalThis.setTimeout;
    try {
      (globalThis as typeof globalThis & {
        setTimeout: typeof setTimeout;
      }).setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) =>
        realSetTimeout(handler, 0, ...args)) as typeof setTimeout;
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
      await Promise.resolve();
      await Promise.resolve();
      const error = await textErrorPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("网页 provider 请求未启动");

      const stored = await chrome.storage.local.get(CURSOR_HELP_SESSION_SLOT_STORAGE_KEY);
      expect(stored[CURSOR_HELP_SESSION_SLOT_STORAGE_KEY]).toEqual({});
    } finally {
      (globalThis as typeof globalThis & {
        setTimeout: typeof setTimeout;
      }).setTimeout = realSetTimeout;
    }
  });
});
