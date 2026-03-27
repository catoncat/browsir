import "./test-setup";

import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../llm-profile-resolver";
import type { BridgeConfig } from "../runtime-infra.browser";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../shared/compaction";

type TestBridgeConfig = Omit<BridgeConfig, "llmProfiles"> & {
  llmProfiles?: unknown;
};

function baseConfig(): TestBridgeConfig {
  return {
    bridgeUrl: "ws://127.0.0.1:8787/ws",
    bridgeToken: "dev-token",
    browserRuntimeStrategy: "host-first",
    compaction: DEFAULT_COMPACTION_SETTINGS,
    llmDefaultProfile: "cursor_help_web",
    llmAuxProfile: "",
    llmFallbackProfile: "",
    llmProviders: [
      {
        id: "cursor_help_web",
        name: "内置模型",
        type: "hosted_chat",
        builtin: true,
      },
    ],
    llmProfiles: [],
    mcpServers: [],
    mcpRefs: {},
    llmSystemPromptCustom: "",
    maxSteps: 100,
    autoTitleInterval: 10,
    bridgeInvokeTimeoutMs: 120_000,
    llmTimeoutMs: 120_000,
    llmRetryMaxAttempts: 2,
    llmMaxRetryDelayMs: 60_000,
    devAutoReload: true,
    devReloadIntervalMs: 1500,
  };
}

describe("llm-profile-resolver.browser", () => {
  it("resolves explicit profile and fallback route", () => {
    const config = baseConfig();
    config.llmProviders = [
      {
        id: "cursor_help_web",
        name: "内置模型",
        type: "hosted_chat",
        builtin: true,
      },
      {
        id: "openai_compatible",
        name: "通用 API",
        type: "model_llm",
        apiConfig: {
          apiBase: "https://example.ai/v1",
          apiKey: "k1",
          supportedModels: ["gpt-basic", "gpt-pro"],
        },
        builtin: true,
      },
    ];
    config.llmProfiles = [
      {
        id: "worker.basic",
        providerId: "openai_compatible",
        modelId: "gpt-basic",
        timeoutMs: 120000,
        retryMaxAttempts: 2,
        maxRetryDelayMs: 60000,
        builtin: false,
      },
      {
        id: "worker.pro",
        providerId: "openai_compatible",
        modelId: "gpt-pro",
        timeoutMs: 120000,
        retryMaxAttempts: 2,
        maxRetryDelayMs: 60000,
        builtin: false,
      },
    ];
    config.llmFallbackProfile = "worker.pro";

    const out = resolveLlmRoute({
      config: config as BridgeConfig,
      profile: "worker.basic",
      role: "worker",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.route.profile).toBe("worker.basic");
    expect(out.route.llmModel).toBe("gpt-basic");
    expect(out.route.orderedProfiles).toEqual(["worker.basic", "worker.pro"]);
    expect(out.route.fromLegacy).toBe(false);
  });

  it("returns profile_not_found when llmProfiles is missing", () => {
    const config = baseConfig();
    const out = resolveLlmRoute({ config: config as BridgeConfig });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("profile_not_found");
  });

  it("returns missing_llm_config when selected profile misses base/key", () => {
    const config = baseConfig();
    config.llmProviders = [
      {
        id: "openai_compatible",
        name: "通用 API",
        type: "model_llm",
        apiConfig: {
          apiBase: "",
          apiKey: "",
        },
        builtin: true,
      },
    ];
    config.llmProfiles = [
      {
        id: "worker.basic",
        providerId: "openai_compatible",
        modelId: "gpt-basic",
        timeoutMs: 120000,
        retryMaxAttempts: 2,
        maxRetryDelayMs: 60000,
        builtin: false,
      },
    ];
    const out = resolveLlmRoute({
      config: config as BridgeConfig,
      profile: "worker.basic",
      role: "worker",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("missing_llm_config");
  });

  it("returns profile_not_found when llmProfiles is object (array-only contract)", () => {
    const config = baseConfig();
    config.llmProfiles = {
      "reviewer.basic": {
        id: "reviewer.basic",
        providerId: "openai_compatible",
        modelId: "gpt-review",
      },
      "reviewer.pro": {
        id: "reviewer.pro",
        providerId: "openai_compatible",
        modelId: "gpt-review-pro",
      },
    } as unknown;
    config.llmFallbackProfile = "reviewer.pro";

    const out = resolveLlmRoute({
      config: config as BridgeConfig,
      profile: "reviewer.basic",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("profile_not_found");
  });
});
