import "./test-setup";

import { describe, expect, it } from "vitest";
import { LlmProviderRegistry } from "../llm-provider-registry";
import {
  normalizeSessionTitle,
  parseLlmContent,
  readSessionTitleSource,
  requestSessionTitleFromLlm,
} from "../loop-session-title";
import type { LlmProviderAdapter, LlmResolvedRoute } from "../llm-provider";

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
});
