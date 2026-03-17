import "./test-setup";

import { describe, expect, it } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";
import { LlmProviderRegistry } from "../llm-provider-registry";
import {
  normalizeSessionTitle,
  parseLlmContent,
  readSessionTitleSource,
  refreshSessionTitleAuto,
  requestSessionTitleFromLlm,
} from "../loop-session-title";
import type { LlmProviderAdapter, LlmResolvedRoute } from "../llm-provider";
import type { RuntimeInfraHandler } from "../runtime-infra.browser";

function createRoute(): LlmResolvedRoute {
  return {
    profile: "default",
    provider: "mock_provider",
    llmBase: "",
    llmKey: "",
    llmModel: "gpt-5.3-codex",
    llmTimeoutMs: 120000,
    llmRetryMaxAttempts: 1,
    llmMaxRetryDelayMs: 60000,
    role: "worker",
    escalationPolicy: "disabled",
    orderedProfiles: ["default"],
    fromLegacy: false,
  };
}

function createTitleInfra(autoTitleInterval = 10): RuntimeInfraHandler {
  return {
    async handleMessage(message: unknown) {
      if (
        message &&
        typeof message === "object" &&
        (message as Record<string, unknown>).type === "config.get"
      ) {
        return {
          ok: true,
          data: {
            bridgeUrl: "",
            bridgeToken: "",
            browserRuntimeStrategy: "browser-first",
            llmDefaultProfile: "title.default",
            llmAuxProfile: "title.default",
            llmFallbackProfile: "",
            llmProfiles: [
              {
                id: "title.default",
                provider: "mock_provider",
                llmApiBase: "https://example.test/v1",
                llmApiKey: "sk-demo",
                llmModel: "gpt-title",
                role: "worker",
              },
            ],
            autoTitleInterval,
            llmTimeoutMs: 120000,
            llmRetryMaxAttempts: 1,
            llmMaxRetryDelayMs: 60000,
          },
        };
      }
      return null;
    },
    disconnectBridge() {},
    abortBridgeInvokesBySession() {
      return 0;
    },
  };
}

describe("loop-session-title", () => {
  it("normalizes session titles and source metadata", () => {
    expect(normalizeSessionTitle("  hello   world  ")).toBe("hello world");
    expect(
      normalizeSessionTitle("0123456789012345678901234567890"),
    ).toBe("0123456789012345678901234567…");
    expect(
      readSessionTitleSource({
        header: {
          type: "session",
          version: 1,
          id: "s1",
          parentSessionId: null,
          timestamp: new Date().toISOString(),
          metadata: {
            titleSource: "ai",
          },
        },
        leafId: null,
        entryCount: 0,
        chunkCount: 0,
        chunkSize: 0,
        updatedAt: new Date().toISOString(),
      }),
    ).toBe("ai");
  });

  it("parses text content from LLM message shapes", () => {
    expect(
      parseLlmContent({
        content: [
          { text: "hello" },
          { type: "text", value: "world" },
        ],
      }),
    ).toBe("hello\nworld");
  });

  it("requests session title from provider and normalizes output", async () => {
    const registry = new LlmProviderRegistry();
    const provider: LlmProviderAdapter = {
      id: "mock_provider",
      resolveRequestUrl() {
        return "https://example.test/v1/chat/completions";
      },
      async send() {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "《调试 Cursor Help Provider》",
                },
              },
            ],
          }),
          {
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    };
    registry.register(provider);

    const title = await requestSessionTitleFromLlm({
      sessionId: "test-session",
      providerRegistry: registry,
      route: createRoute(),
      messages: [
        {
          role: "user",
          content: "请帮我调试 cursor help provider 的 fetch hook 行为",
        },
      ],
    });

    expect(title).toBe("调试 Cursor Help Provi");
  });

  it("requests session title from hosted chat transport response", async () => {
    const registry = new LlmProviderRegistry();
    const provider: LlmProviderAdapter = {
      id: "mock_provider",
      resolveRequestUrl() {
        return "browser-brain-loop://hosted-chat/title";
      },
      async send() {
        return new Response(
          [
            JSON.stringify({
              type: "hosted_chat.debug",
              requestId: "title_1",
              stage: "request_started",
            }),
            JSON.stringify({
              type: "hosted_chat.turn_resolved",
              requestId: "title_1",
              result: {
                assistantText: "Cursor支持助手能力介绍",
                toolCalls: [],
                finishReason: "stop",
                meta: {
                  assistantTextLength: 17,
                },
              },
            }),
          ].join("\n"),
          {
            headers: {
              "content-type":
                "application/x-browser-brain-loop-hosted-chat+jsonl",
            },
          },
        );
      },
    };
    registry.register(provider);

    const title = await requestSessionTitleFromLlm({
      sessionId: "test-session",
      providerRegistry: registry,
      route: createRoute(),
      messages: [
        {
          role: "user",
          content: "请总结 Cursor 支持助手的能力介绍",
        },
      ],
    });

    expect(title).toBe("Cursor支持助手能力介绍");
  });

  it("自动标题只在首次和每个 interval 里程碑触发一次", async () => {
    const orchestrator = new BrainOrchestrator();
    const registry = new LlmProviderRegistry();
    let requestCount = 0;
    const provider: LlmProviderAdapter = {
      id: "mock_provider",
      resolveRequestUrl() {
        return "https://example.test/v1/chat/completions";
      },
      async send() {
        requestCount += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                },
              },
            ],
          }),
          {
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    };
    registry.register(provider);

    const created = await orchestrator.createSession({ title: "新对话" });
    const sessionId = created.sessionId;

    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "user",
      text: "帮我起个标题",
    });
    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "好的，我先看看上下文",
    });

    const infra = createTitleInfra(10);

    await refreshSessionTitleAuto(
      orchestrator,
      sessionId,
      infra,
      registry,
    );
    await refreshSessionTitleAuto(
      orchestrator,
      sessionId,
      infra,
      registry,
    );
    expect(requestCount).toBe(1);

    for (let i = 0; i < 8; i += 1) {
      await orchestrator.sessions.appendMessage({
        sessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        text: `补充消息 ${i + 1}`,
      });
    }

    await refreshSessionTitleAuto(
      orchestrator,
      sessionId,
      infra,
      registry,
    );
    await refreshSessionTitleAuto(
      orchestrator,
      sessionId,
      infra,
      registry,
    );
    expect(requestCount).toBe(2);
  });
});
