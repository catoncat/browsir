import "./test-setup";

import { describe, expect, it } from "vitest";
import { LlmProviderRegistry } from "../llm-provider-registry";
import type { LlmProviderAdapter } from "../llm-provider";

function createProvider(id: string): LlmProviderAdapter {
  return {
    id,
    resolveRequestUrl: () => "https://example.ai/v1/chat/completions",
    send: async () => new Response("{}")
  };
}

describe("llm-provider-registry.browser", () => {
  it("registers and resolves providers by id", () => {
    const registry = new LlmProviderRegistry();
    const provider = createProvider("openai_compatible");
    registry.register(provider);
    expect(registry.has("openai_compatible")).toBe(true);
    expect(registry.get("openai_compatible")?.id).toBe("openai_compatible");
  });

  it("rejects duplicate registration unless replace=true", () => {
    const registry = new LlmProviderRegistry();
    registry.register(createProvider("openai_compatible"));
    expect(() => registry.register(createProvider("openai_compatible"))).toThrow("already registered");
    registry.register(createProvider("openai_compatible"), { replace: true });
    expect(registry.get("openai_compatible")?.id).toBe("openai_compatible");
  });

  it("supports unregister", () => {
    const registry = new LlmProviderRegistry();
    registry.register(createProvider("openai_compatible"));
    expect(registry.unregister("openai_compatible")).toBe(true);
    expect(registry.has("openai_compatible")).toBe(false);
  });
});
