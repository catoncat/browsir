import "./test-setup";

import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../llm-profile-resolver";
import type { BridgeConfig } from "../runtime-infra.browser";

type TestBridgeConfig = BridgeConfig & {
  llmProfiles?: unknown;
  llmProfileChains?: unknown;
};

function baseConfig(): TestBridgeConfig {
  return {
    bridgeUrl: "ws://127.0.0.1:8787/ws",
    bridgeToken: "dev-token",
    llmDefaultProfile: "default",
    maxSteps: 100,
    autoTitleInterval: 10,
    bridgeInvokeTimeoutMs: 120_000,
    llmTimeoutMs: 120_000,
    llmRetryMaxAttempts: 2,
    llmMaxRetryDelayMs: 60_000,
    devAutoReload: true,
    devReloadIntervalMs: 1500
  };
}

describe("llm-profile-resolver.browser", () => {
  it("resolves explicit profile and ordered chain", () => {
    const config = baseConfig();
    config.llmProfiles = [
      {
        id: "worker.basic",
        provider: "openai_compatible",
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "k1",
        llmModel: "gpt-basic",
        role: "worker"
      },
      {
        id: "worker.pro",
        provider: "openai_compatible",
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "k2",
        llmModel: "gpt-pro",
        role: "worker"
      }
    ];
    config.llmProfileChains = {
      worker: ["worker.basic", "worker.pro"]
    };

    const out = resolveLlmRoute({
      config: config as BridgeConfig,
      profile: "worker.pro",
      role: "worker"
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.route.profile).toBe("worker.pro");
    expect(out.route.llmModel).toBe("gpt-pro");
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
    config.llmProfiles = [
      {
        id: "worker.basic",
        provider: "openai_compatible",
        llmApiBase: "",
        llmApiKey: "",
        llmModel: "gpt-basic",
        role: "worker"
      }
    ];
    const out = resolveLlmRoute({
      config: config as BridgeConfig,
      profile: "worker.basic",
      role: "worker"
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
        provider: "openai_compatible",
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "k-review",
        llmModel: "gpt-review",
        role: "reviewer"
      },
      "reviewer.pro": {
        id: "reviewer.pro",
        provider: "openai_compatible",
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "k-review-pro",
        llmModel: "gpt-review-pro",
        role: "reviewer"
      }
    };
    config.llmProfileChains = {
      reviewer: ["reviewer.basic", "reviewer.pro"]
    };

    const out = resolveLlmRoute({
      config: config as BridgeConfig,
      profile: "reviewer.basic"
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("profile_not_found");
  });
});
