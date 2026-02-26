import "./test-setup";

import { describe, expect, it, vi } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";
import { registerExtension } from "../extension-api";
import type { LlmResolvedRoute } from "../llm-provider";

function createDummyRoute(overrides: Partial<LlmResolvedRoute> = {}): LlmResolvedRoute {
  return {
    profile: "default",
    provider: "openai_compatible",
    llmBase: "https://example.invalid/v1",
    llmKey: "demo-key",
    llmModel: "gpt-test",
    llmTimeoutMs: 120000,
    llmRetryMaxAttempts: 2,
    llmMaxRetryDelayMs: 60000,
    role: "worker",
    escalationPolicy: "upgrade_only",
    orderedProfiles: ["default"],
    fromLegacy: false,
    ...overrides
  };
}

describe("extension-api.browser", () => {
  it("on() 支持同一 hook 多次注册并按顺序生效", async () => {
    const orchestrator = new BrainOrchestrator();
    orchestrator.registerToolProvider(
      "script",
      {
        id: "ext-api.chain.script",
        invoke: async () => ({ chain: ["base"] })
      },
      { replace: true }
    );
    const { sessionId } = await orchestrator.createSession({ title: "extension-api-hook-chain" });

    registerExtension(
      orchestrator,
      {
        id: "extension.api.hook.chain",
        name: "extension-api-hook-chain",
        version: "1.0.0",
        permissions: {
          hooks: ["tool.after_result"]
        }
      },
      (pi) => {
        pi.on("tool.after_result", (event) => {
          const prev = (event.result || {}) as { chain?: string[] };
          return {
            action: "patch",
            patch: {
              result: {
                ...prev,
                chain: [...(prev.chain || []), "h1"]
              }
            }
          };
        });
        pi.on("tool.after_result", (event) => {
          const prev = (event.result || {}) as { chain?: string[] };
          return {
            action: "patch",
            patch: {
              result: {
                ...prev,
                chain: [...(prev.chain || []), "h2"]
              }
            }
          };
        });
      }
    );

    const result = await orchestrator.executeStep({
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off"
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ chain: ["base", "h1", "h2"] });
  });

  it("registerProvider 可覆盖并在 disable 后回滚 LLM provider", () => {
    const orchestrator = new BrainOrchestrator();
    const baseProvider = orchestrator.getLlmProvider("openai_compatible");
    expect(baseProvider).toBeDefined();

    const send = vi.fn(async () => new Response("{}", { status: 200 }));
    registerExtension(
      orchestrator,
      {
        id: "extension.api.llm.provider",
        name: "extension-api-llm-provider",
        version: "1.0.0",
        permissions: {
          llmProviders: ["openai_compatible"],
          replaceLlmProviders: true
        }
      },
      (pi) => {
        pi.registerProvider("openai_compatible", {
          resolveRequestUrl: () => "https://proxy.example.com/chat/completions",
          send
        });
      }
    );

    const activeProvider = orchestrator.getLlmProvider("openai_compatible");
    expect(activeProvider).toBeDefined();
    expect(activeProvider).not.toBe(baseProvider);
    const targetUrl = activeProvider?.resolveRequestUrl(createDummyRoute()) || "";
    expect(targetUrl).toBe("https://proxy.example.com/chat/completions");
    expect(orchestrator.listLlmProviders().some((item) => item.id === "openai_compatible")).toBe(true);

    orchestrator.disablePlugin("extension.api.llm.provider");
    const restored = orchestrator.getLlmProvider("openai_compatible");
    expect(restored).toBe(baseProvider);
  });
});
