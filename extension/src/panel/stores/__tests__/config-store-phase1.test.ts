import { describe, expect, it } from "vitest";

import {
  convertToLegacyBridgeConfig,
  isLegacyConfig,
  migrateLegacyProfile,
  normalizePanelConfig,
  type PanelConfigNew,
  type PanelLlmProfile,
} from "../config-store";

describe("config-store Phase 1", () => {
  describe("migrateLegacyProfile", () => {
    it("splits a legacy profile into provider + profile", () => {
      const legacy: PanelLlmProfile = {
        id: "writer",
        provider: "openai",
        llmApiBase: "https://api.example.com/v1",
        llmApiKey: "sk-test-key-123",
        llmModel: "gpt-4.1",
        providerOptions: {
          contextWindow: 128000,
          maxOutputTokens: 4096,
          temperature: 0.7,
          topP: 1,
          frequencyPenalty: 0,
          presencePenalty: 0,
          stop: ["</END>"],
        },
        llmTimeoutMs: 30000,
        llmRetryMaxAttempts: 3,
        llmMaxRetryDelayMs: 60000,
      };

      const result = migrateLegacyProfile(legacy, "provider-writer");

      expect(result.provider.id).toBe("provider-writer");
      expect(result.provider.name).toBe("OpenAI");
      expect(result.provider.type).toBe("model_llm");
      expect(result.provider.apiConfig?.apiBase).toBe("https://api.example.com/v1");
      expect(result.provider.apiConfig?.apiKey).toBe("sk-test-key-123");
      expect(result.provider.apiConfig?.defaultModel).toBe("gpt-4.1");
      expect(result.provider.options).toEqual({});

      expect(result.profile.id).toBe("writer");
      expect(result.profile.providerId).toBe("provider-writer");
      expect(result.profile.modelId).toBe("gpt-4.1");
      expect(result.profile.timeoutMs).toBe(30000);
      expect(result.profile.retryMaxAttempts).toBe(3);
      expect(result.profile.maxRetryDelayMs).toBe(60000);
      expect(result.profile.contextWindow).toBe(128000);
      expect(result.profile.stop).toEqual(["</END>"]);
    });

    it("keeps hosted_chat providers free of apiConfig", () => {
      const legacy: PanelLlmProfile = {
        id: "cursor-profile",
        provider: "cursor_help_web",
        llmApiBase: "should-be-cleared",
        llmApiKey: "should-be-cleared",
        llmModel: "auto",
        providerOptions: {
          targetSite: "cursor_help",
        },
        llmTimeoutMs: 60000,
        llmRetryMaxAttempts: 1,
        llmMaxRetryDelayMs: 60000,
      };

      const result = migrateLegacyProfile(legacy, "cursor_help_web");

      expect(result.provider.type).toBe("hosted_chat");
      expect(result.provider.apiConfig).toBeUndefined();
      expect(result.profile.providerId).toBe("cursor_help_web");
      expect(result.profile.modelId).toBe("auto");
    });
  });

  describe("isLegacyConfig", () => {
    it("detects legacy config by llmApiBase/llmApiKey fields", () => {
      expect(
        isLegacyConfig({
          llmProfiles: [
            {
              id: "writer",
              provider: "openai",
              llmApiBase: "https://api.openai.com/v1",
              llmApiKey: "sk-1",
              llmModel: "gpt-4.1",
            },
          ],
        }),
      ).toBe(true);
    });

    it("recognizes the new provider/profile split format", () => {
      expect(
        isLegacyConfig({
          llmProviders: [
            {
              id: "openai",
              name: "OpenAI",
              type: "model_llm",
              builtin: false,
            },
          ],
          llmProfiles: [
            {
              id: "writer",
              providerId: "openai",
              modelId: "gpt-4.1",
            },
          ],
        }),
      ).toBe(false);
    });
  });

  describe("normalizePanelConfig", () => {
    it("migrates legacy config into target-state panel config and injects builtin provider/profile", () => {
      const result = normalizePanelConfig({
        bridgeUrl: "ws://127.0.0.1:8787/ws",
        bridgeToken: "token-123",
        llmDefaultProfile: "writer",
        llmAuxProfile: "",
        llmFallbackProfile: "",
        llmSystemPromptCustom: "system prompt",
        maxSteps: 88,
        autoTitleInterval: 9,
        bridgeInvokeTimeoutMs: 45000,
        llmTimeoutMs: 32000,
        llmRetryMaxAttempts: 3,
        llmMaxRetryDelayMs: 8000,
        llmProfiles: [
          {
            id: "writer",
            provider: "openai",
            llmApiBase: "https://api.openai.com/v1",
            llmApiKey: "sk-openai-key",
            llmModel: "gpt-4.1",
            providerOptions: {
              contextWindow: 128000,
            },
            llmTimeoutMs: 30000,
            llmRetryMaxAttempts: 3,
            llmMaxRetryDelayMs: 60000,
          },
        ],
      });

      expect(result.bridgeToken).toBe("token-123");
      expect(result.llmDefaultProfile).toBe("writer");
      expect(result.llmSystemPromptCustom).toBe("system prompt");
      expect(result.maxSteps).toBe(88);

      expect(result.llmProviders.map((item) => item.id)).toEqual(
        expect.arrayContaining(["openai", "openai_compatible", "cursor_help_web"]),
      );
      expect(result.llmProfiles.map((item) => item.id)).toEqual(
        expect.arrayContaining(["writer", "cursor_help_web"]),
      );

      const writer = result.llmProfiles.find((item) => item.id === "writer");
      expect(writer?.providerId).toBe("openai");
      expect(writer?.modelId).toBe("gpt-4.1");

      const openaiProvider = result.llmProviders.find((item) => item.id === "openai");
      expect(openaiProvider?.apiConfig?.apiBase).toBe("https://api.openai.com/v1");
      expect(openaiProvider?.apiConfig?.apiKey).toBe("sk-openai-key");
    });

    it("splits legacy profiles into distinct providers when connection configs differ", () => {
      const result = normalizePanelConfig({
        llmDefaultProfile: "writer",
        llmProfiles: [
          {
            id: "writer",
            provider: "openai_compatible",
            llmApiBase: "https://a.example.com/v1",
            llmApiKey: "sk-a",
            llmModel: "gpt-4.1",
            llmTimeoutMs: 30000,
            llmRetryMaxAttempts: 3,
            llmMaxRetryDelayMs: 60000,
          },
          {
            id: "reviewer",
            provider: "openai_compatible",
            llmApiBase: "https://b.example.com/v1",
            llmApiKey: "sk-b",
            llmModel: "gpt-4o",
            llmTimeoutMs: 30000,
            llmRetryMaxAttempts: 3,
            llmMaxRetryDelayMs: 60000,
          },
        ],
      });

      const migratedProfiles = result.llmProfiles.filter(
        (item) => item.id === "writer" || item.id === "reviewer",
      );
      expect(migratedProfiles).toHaveLength(2);
      expect(new Set(migratedProfiles.map((item) => item.providerId)).size).toBe(2);

      const migratedProviders = result.llmProviders.filter(
        (item) =>
          item.apiConfig?.apiBase === "https://a.example.com/v1" ||
          item.apiConfig?.apiBase === "https://b.example.com/v1",
      );
      expect(migratedProviders).toHaveLength(2);
    });

    it("normalizes new-format config and repairs missing builtins and dangling profile references", () => {
      const result = normalizePanelConfig({
        llmDefaultProfile: "missing-default",
        llmAuxProfile: "ghost",
        llmFallbackProfile: "fallback",
        llmProviders: [
          {
            id: "shared-openai",
            name: "Shared OpenAI",
            type: "model_llm",
            apiConfig: {
              apiBase: "https://api.openai.com/v1",
              apiKey: "sk-shared",
            },
            builtin: false,
          },
        ],
        llmProfiles: [
          {
            id: "fallback",
            providerId: "shared-openai",
            modelId: "gpt-4.1",
            timeoutMs: 45000,
            retryMaxAttempts: 2,
            maxRetryDelayMs: 12000,
            builtin: false,
          },
        ],
      });

      expect(result.llmDefaultProfile).toBe("fallback");
      expect(result.llmAuxProfile).toBe("");
      expect(result.llmFallbackProfile).toBe("");
      expect(result.llmProviders.map((item) => item.id)).toEqual(
        expect.arrayContaining(["shared-openai", "openai_compatible", "cursor_help_web"]),
      );
      expect(result.llmProfiles.map((item) => item.id)).toEqual(
        expect.arrayContaining(["fallback", "cursor_help_web"]),
      );
    });

    it("canonicalizes interrupted built-in cursor profile ids in new-format config", () => {
      const result = normalizePanelConfig({
        llmDefaultProfile: "built-in",
        llmProviders: [
          {
            id: "openai_compatible",
            name: "通用 API",
            type: "model_llm",
            apiConfig: {
              apiBase: "https://ai.chen.rs/v1",
              apiKey: "sk-test",
            },
            builtin: true,
          },
          {
            id: "cursor_help_web",
            name: "Cursor 宿主聊天",
            type: "hosted_chat",
            builtin: true,
          },
        ],
        llmProfiles: [
          {
            id: "default",
            providerId: "openai_compatible",
            modelId: "gpt-5.3-codex",
            timeoutMs: 120000,
            retryMaxAttempts: 2,
            maxRetryDelayMs: 60000,
            builtin: false,
          },
          {
            id: "built-in",
            providerId: "cursor_help_web",
            modelId: "auto",
            timeoutMs: 120000,
            retryMaxAttempts: 1,
            maxRetryDelayMs: 60000,
            builtin: true,
          },
        ],
      });

      const cursorProfiles = result.llmProfiles.filter(
        (item) => item.providerId === "cursor_help_web",
      );
      expect(cursorProfiles).toHaveLength(1);
      expect(cursorProfiles[0]?.id).toBe("cursor_help_web");
      expect(result.llmDefaultProfile).toBe("cursor_help_web");
    });
  });

  describe("convertToLegacyBridgeConfig", () => {
    it("converts the target-state config into bridge-compatible legacy config", () => {
      const newConfig: PanelConfigNew = {
        bridgeUrl: "ws://127.0.0.1:8787/ws",
        bridgeToken: "token-abc",
        browserRuntimeStrategy: "browser-first",
        compaction: {
          enabled: true,
          contextWindow: 32000,
          maxTokens: 16000,
          reserveTokens: 4000,
          keepSystemPrompt: true,
          keepToolSchema: true,
          keepRecentUserMessages: 4,
        },
        llmProviders: [
          {
            id: "shared-openai",
            name: "Shared OpenAI",
            type: "model_llm",
            apiConfig: {
              apiBase: "https://api.openai.com/v1",
              apiKey: "sk-test-key",
              defaultModel: "gpt-4.1",
              supportedModels: ["gpt-4.1", "gpt-4o"],
              supportsModelDiscovery: false,
            },
            options: {
              endpointTag: "shared",
            },
            builtin: false,
          },
          {
            id: "cursor_help_web",
            name: "Cursor 宿主聊天",
            type: "hosted_chat",
            options: {
              targetSite: "cursor_help",
            },
            builtin: true,
          },
        ],
        llmProfiles: [
          {
            id: "writer",
            providerId: "shared-openai",
            modelId: "gpt-4.1",
            timeoutMs: 30000,
            retryMaxAttempts: 3,
            maxRetryDelayMs: 60000,
            contextWindow: 128000,
            maxOutputTokens: 4096,
            temperature: 0.4,
            topP: 0.9,
            frequencyPenalty: 0,
            presencePenalty: 0,
            stop: ["</END>"],
            builtin: false,
          },
        ],
        llmDefaultProfile: "writer",
        llmAuxProfile: "",
        llmFallbackProfile: "",
        llmSystemPromptCustom: "custom prompt",
        maxSteps: 88,
        autoTitleInterval: 9,
        bridgeInvokeTimeoutMs: 45000,
        llmTimeoutMs: 32000,
        llmRetryMaxAttempts: 3,
        llmMaxRetryDelayMs: 8000,
        devAutoReload: false,
        devReloadIntervalMs: 1500,
      };

      const result = convertToLegacyBridgeConfig(newConfig);

      expect(result.bridgeToken).toBe("token-abc");
      expect(result.llmDefaultProfile).toBe("writer");
      expect(result.llmProfiles).toHaveLength(1);
      expect(result.llmProfiles[0].provider).toBe("shared-openai");
      expect(result.llmProfiles[0].llmApiBase).toBe("https://api.openai.com/v1");
      expect(result.llmProfiles[0].llmApiKey).toBe("sk-test-key");
      expect(result.llmProfiles[0].llmModel).toBe("gpt-4.1");
      expect(result.llmProfiles[0].providerOptions).toMatchObject({
        contextWindow: 128000,
        maxOutputTokens: 4096,
        endpointTag: "shared",
      });
    });

    it("throws when a profile points to a missing provider", () => {
      const badConfig = normalizePanelConfig({
        llmProviders: [],
        llmProfiles: [
          {
            id: "writer",
            providerId: "missing-provider",
            modelId: "gpt-4.1",
            timeoutMs: 30000,
            retryMaxAttempts: 3,
            maxRetryDelayMs: 60000,
            builtin: false,
          },
        ],
      });

      const brokenConfig: PanelConfigNew = {
        ...badConfig,
        llmProviders: badConfig.llmProviders.filter(
          (item) => item.id !== "missing-provider",
        ),
        llmProfiles: badConfig.llmProfiles.filter((item) => item.id === "writer"),
      };

      expect(() => convertToLegacyBridgeConfig(brokenConfig)).toThrow(
        "Provider 'missing-provider' not found",
      );
    });

    it("keeps the builtin cursor profile when builtin route is selected", () => {
      const newConfig = normalizePanelConfig({
        llmProviders: [
          {
            id: "custom-provider",
            name: "Custom",
            type: "model_llm",
            apiConfig: {
              apiBase: "https://api.example.com/v1",
              apiKey: "sk-test",
              defaultModel: "gpt-4.1",
              supportedModels: ["gpt-4.1", "gpt-4o-mini"],
              supportsModelDiscovery: true,
            },
            builtin: false,
          },
        ],
        llmProfiles: [
          {
            id: "custom-primary",
            providerId: "custom-provider",
            modelId: "gpt-4.1",
            timeoutMs: 120000,
            retryMaxAttempts: 2,
            maxRetryDelayMs: 60000,
            builtin: false,
          },
        ],
        llmDefaultProfile: "cursor_help_web",
      });

      const result = convertToLegacyBridgeConfig(newConfig);
      const cursorProfile = result.llmProfiles.find(
        (item) => item.id === "cursor_help_web",
      );

      expect(result.llmDefaultProfile).toBe("cursor_help_web");
      expect(cursorProfile).toBeDefined();
      expect(cursorProfile?.provider).toBe("cursor_help_web");
      expect(cursorProfile?.llmModel).toBe("auto");
    });
  });
});
