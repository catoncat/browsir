import { describe, expect, it } from "vitest";

import { normalizePanelConfig } from "../../stores/config-store";
import {
  applyProviderSettingsDraft,
  collectProviderModelOptions,
  deriveManagedProviderId,
  deriveProviderSettingsDraft,
  resetToBuiltinCursor,
} from "../provider-settings-state";

describe("provider-settings-state", () => {
  it("prefers the provider used by the active non-cursor route", () => {
    const config = normalizePanelConfig({
      llmProviders: [
        {
          id: "shared-openai",
          name: "Shared OpenAI",
          type: "model_llm",
          apiConfig: {
            apiBase: "https://api.example.com/v1",
            apiKey: "sk-test",
            supportedModels: ["gpt-4.1", "gpt-4o"],
          },
          builtin: false,
        },
      ],
      llmProfiles: [
        {
          id: "writer",
          providerId: "shared-openai",
          modelId: "gpt-4.1",
          timeoutMs: 30000,
          retryMaxAttempts: 2,
          maxRetryDelayMs: 60000,
          builtin: false,
        },
      ],
      llmDefaultProfile: "writer",
    });

    expect(deriveManagedProviderId(config)).toBe("shared-openai");
    expect(deriveProviderSettingsDraft(config)).toEqual({
      primaryModelId: "gpt-4.1",
      auxModelId: "",
      fallbackModelId: "",
    });
  });

  it("merges provider-discovered models with assigned route models", () => {
    const config = normalizePanelConfig({
      llmProviders: [
        {
          id: "shared-openai",
          name: "Shared OpenAI",
          type: "model_llm",
          apiConfig: {
            apiBase: "https://api.example.com/v1",
            apiKey: "sk-test",
            defaultModel: "gpt-4.1",
            supportedModels: ["gpt-4.1", "gpt-4o"],
          },
          builtin: false,
        },
      ],
      llmProfiles: [
        {
          id: "writer",
          providerId: "shared-openai",
          modelId: "gpt-4.1",
          timeoutMs: 30000,
          retryMaxAttempts: 2,
          maxRetryDelayMs: 60000,
          builtin: false,
        },
        {
          id: "fallback",
          providerId: "shared-openai",
          modelId: "o3-mini",
          timeoutMs: 30000,
          retryMaxAttempts: 2,
          maxRetryDelayMs: 60000,
          builtin: false,
        },
      ],
      llmDefaultProfile: "writer",
      llmFallbackProfile: "fallback",
    });

    expect(collectProviderModelOptions(config, "shared-openai")).toEqual([
      "gpt-4.1",
      "gpt-4o",
      "o3-mini",
    ]);
  });

  it("maps primary/aux/fallback model picks back to hidden profiles", () => {
    const config = normalizePanelConfig({
      llmDefaultProfile: "cursor_help_web",
    });

    applyProviderSettingsDraft(
      config,
      {
        primaryModelId: "gpt-4.1",
        auxModelId: "gpt-4o-mini",
        fallbackModelId: "o3",
      },
      "openai_compatible",
    );

    expect(config.llmDefaultProfile).toBe("custom-primary");
    expect(config.llmAuxProfile).toBe("custom-aux");
    expect(config.llmFallbackProfile).toBe("custom-fallback");

    const primary = config.llmProfiles.find((item) => item.id === "custom-primary");
    const aux = config.llmProfiles.find((item) => item.id === "custom-aux");
    const fallback = config.llmProfiles.find(
      (item) => item.id === "custom-fallback",
    );

    expect(primary?.providerId).toBe("openai_compatible");
    expect(primary?.modelId).toBe("gpt-4.1");
    expect(aux?.modelId).toBe("gpt-4o-mini");
    expect(fallback?.modelId).toBe("o3");
    expect(
      config.llmProviders.find((item) => item.id === "openai_compatible")?.apiConfig
        ?.supportedModels,
    ).toEqual(expect.arrayContaining(["gpt-4.1", "gpt-4o-mini", "o3"]));
  });

  it("falls back to builtin cursor when custom selection is cleared", () => {
    const config = normalizePanelConfig({
      llmProviders: [
        {
          id: "shared-openai",
          name: "Shared OpenAI",
          type: "model_llm",
          apiConfig: {
            apiBase: "https://api.example.com/v1",
            apiKey: "sk-test",
            defaultModel: "gpt-4.1",
            supportedModels: ["gpt-4.1"],
          },
          builtin: false,
        },
      ],
      llmProfiles: [
        {
          id: "writer",
          providerId: "shared-openai",
          modelId: "gpt-4.1",
          timeoutMs: 30000,
          retryMaxAttempts: 2,
          maxRetryDelayMs: 60000,
          builtin: false,
        },
      ],
      llmDefaultProfile: "writer",
    });

    resetToBuiltinCursor(config);

    expect(config.llmDefaultProfile).toBe("cursor_help_web");
    expect(config.llmAuxProfile).toBe("");
    expect(config.llmFallbackProfile).toBe("");
  });
});
