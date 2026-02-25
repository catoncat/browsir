import "./test-setup";

import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../llm-profile-resolver";
import type { BridgeConfig } from "../runtime-infra.browser";

function baseConfig(): BridgeConfig {
  return {
    bridgeUrl: "ws://127.0.0.1:8787/ws",
    bridgeToken: "dev-token",
    llmApiBase: "https://example.ai/v1",
    llmApiKey: "sk-demo",
    llmModel: "gpt-legacy",
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
  it("falls back to legacy config when llmProfiles is absent", () => {
    const out = resolveLlmRoute({
      config: baseConfig()
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.route.profile).toBe("default");
    expect(out.route.provider).toBe("openai_compatible");
    expect(out.route.llmModel).toBe("gpt-legacy");
    expect(out.route.fromLegacy).toBe(true);
  });

  it("resolves explicit profile and ordered chain", () => {
    const config = baseConfig();
    (config as BridgeConfig & { llmProfiles?: unknown; llmDefaultProfile?: string; llmProfileChains?: unknown }).llmProfiles = [
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
    (config as BridgeConfig & { llmDefaultProfile?: string }).llmDefaultProfile = "worker.basic";
    (config as BridgeConfig & { llmProfileChains?: unknown }).llmProfileChains = {
      worker: ["worker.basic", "worker.pro"]
    };

    const out = resolveLlmRoute({
      config,
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

  it("returns missing_llm_config when selected profile misses base/key", () => {
    const config = baseConfig();
    (config as BridgeConfig & { llmProfiles?: unknown }).llmProfiles = [
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
      config,
      profile: "worker.basic",
      role: "worker"
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("missing_llm_config");
  });

  it("uses selected profile role when request role is not provided", () => {
    const config = baseConfig();
    (config as BridgeConfig & { llmProfiles?: unknown; llmDefaultProfile?: string; llmProfileChains?: unknown }).llmProfiles = [
      {
        id: "reviewer.basic",
        provider: "openai_compatible",
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "k-review",
        llmModel: "gpt-review",
        role: "reviewer"
      },
      {
        id: "reviewer.pro",
        provider: "openai_compatible",
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "k-review-pro",
        llmModel: "gpt-review-pro",
        role: "reviewer"
      }
    ];
    (config as BridgeConfig & { llmDefaultProfile?: string }).llmDefaultProfile = "reviewer.basic";
    (config as BridgeConfig & { llmProfileChains?: unknown }).llmProfileChains = {
      reviewer: ["reviewer.basic", "reviewer.pro"]
    };

    const out = resolveLlmRoute({
      config
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.route.profile).toBe("reviewer.basic");
    expect(out.route.role).toBe("reviewer");
    expect(out.route.orderedProfiles).toEqual(["reviewer.basic", "reviewer.pro"]);
  });
});
