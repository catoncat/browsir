import { describe, expect, it } from "vitest";

import { normalizePanelConfig } from "../../stores/config-store";
import {
  applySceneModelDraft,
  applyProviderSettingsDraft,
  collectSceneModelOptions,
  collectProviderModelOptions,
  createSceneModelValue,
  deriveManagedProviderId,
  deriveProviderSettingsDraft,
  deriveSceneModelDraft,
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

  it("collects builtin free and custom provider models into one option list", () => {
    const config = normalizePanelConfig({
      llmProviders: [
        {
          id: "openrouter",
          name: "OpenRouter",
          type: "model_llm",
          apiConfig: {
            apiBase: "https://openrouter.ai/api/v1",
            apiKey: "sk-test",
            defaultModel: "gpt-4.1",
            supportedModels: ["gpt-4.1", "gpt-4o-mini"],
          },
          builtin: false,
        },
      ],
      llmProfiles: [
        {
          id: "openrouter-writer",
          providerId: "openrouter",
          modelId: "gpt-4.1",
          timeoutMs: 30000,
          retryMaxAttempts: 2,
          maxRetryDelayMs: 60000,
          builtin: false,
        },
      ],
      llmDefaultProfile: "openrouter-writer",
    });

    const options = collectSceneModelOptions(config, {
      selectedModel: "gpt-5",
      availableModels: ["gpt-5", "claude-sonnet-4.6"],
    });

    expect(options.map((item) => item.label)).toEqual([
      "内置模型 / GPT-5",
      "内置模型 / Sonnet 4.6",
      "OpenRouter / gpt-4.1",
      "OpenRouter / gpt-4o-mini",
    ]);
  });

  it("dedupes builtin free alias variants and keeps the current builtin selection canonical", () => {
    const config = normalizePanelConfig({
      llmDefaultProfile: "cursor_help_web",
      llmProfiles: [
        {
          id: "cursor_help_web",
          providerId: "cursor_help_web",
          modelId: "anthropic/claude-sonnet-4.6",
          timeoutMs: 120000,
          retryMaxAttempts: 2,
          maxRetryDelayMs: 60000,
          builtin: true,
        },
      ],
    });

    const builtinCatalog = {
      selectedModel: "anthropic/claude-sonnet-4.6",
      availableModels: ["Sonnet 4.6", "GPT-5.1 Codex Mini", "Gemini 3 Flash"],
    };

    const options = collectSceneModelOptions(config, builtinCatalog);
    expect(options.map((item) => item.label)).toEqual([
      "内置模型 / Sonnet 4.6",
      "内置模型 / GPT-5.1 Codex Mini",
      "内置模型 / Gemini 3 Flash",
    ]);

    expect(deriveSceneModelDraft(config, builtinCatalog).primaryValue).toBe(
      createSceneModelValue("cursor_help_web", "Sonnet 4.6"),
    );
  });

  it("maps scene model selections back to concrete route profiles", () => {
    const config = normalizePanelConfig({
      llmProviders: [
        {
          id: "openrouter",
          name: "OpenRouter",
          type: "model_llm",
          apiConfig: {
            apiBase: "https://openrouter.ai/api/v1",
            apiKey: "sk-test",
            supportedModels: ["gpt-4o-mini"],
          },
          builtin: false,
        },
      ],
      llmDefaultProfile: "cursor_help_web",
    });

    applySceneModelDraft(config, {
      primaryValue: createSceneModelValue("cursor_help_web", "GPT-5"),
      auxValue: createSceneModelValue("openrouter", "gpt-4o-mini"),
      fallbackValue: "",
    });

    const primary = config.llmProfiles.find(
      (item) => item.id === config.llmDefaultProfile,
    );
    const aux = config.llmProfiles.find((item) => item.id === config.llmAuxProfile);

    expect(primary?.providerId).toBe("cursor_help_web");
    expect(primary?.modelId).toBe("GPT-5");
    expect(aux?.providerId).toBe("openrouter");
    expect(aux?.modelId).toBe("gpt-4o-mini");
    expect(config.llmFallbackProfile).toBe("");
  });
});
