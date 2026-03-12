import "./test-setup";

import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../llm-profile-resolver";
import type { BridgeConfig } from "../runtime-infra.browser";
import { CURSOR_HELP_WEB_API_KEY, CURSOR_HELP_WEB_BASE_URL } from "../../../shared/llm-provider-config";

function baseConfig(): BridgeConfig & { llmProfiles?: unknown; llmProfileChains?: unknown } {
  return {
    bridgeUrl: "ws://127.0.0.1:8787/ws",
    bridgeToken: "dev-token",
    browserRuntimeStrategy: "host-first",
    llmDefaultProfile: "cursor-help",
    llmProfiles: [],
    llmProfileChains: {},
    llmEscalationPolicy: "upgrade_only",
    maxSteps: 10,
    autoTitleInterval: 10,
    bridgeInvokeTimeoutMs: 120000,
    llmTimeoutMs: 120000,
    llmRetryMaxAttempts: 2,
    llmMaxRetryDelayMs: 60000,
    devAutoReload: false,
    devReloadIntervalMs: 1500
  };
}

describe("llm-profile-resolver cursor_help_web", () => {
  it("rejects cursor_help_web profiles that bypass core base/key config", () => {
    const config = baseConfig();
    config.llmProfiles = [
      {
        id: "cursor-help",
        provider: "cursor_help_web",
        llmApiBase: "",
        llmApiKey: "",
        llmModel: "auto",
        providerOptions: {
          targetTabId: 88,
          targetSite: "cursor_help"
        },
        role: "worker",
        llmTimeoutMs: 120000,
        llmRetryMaxAttempts: 2,
        llmMaxRetryDelayMs: 60000
      }
    ];

    const result = resolveLlmRoute({ config });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_llm_config");
  });

  it("accepts normalized cursor_help_web provider config", () => {
    const config = baseConfig();
    config.llmProfiles = [
      {
        id: "cursor-help",
        provider: "cursor_help_web",
        llmApiBase: CURSOR_HELP_WEB_BASE_URL,
        llmApiKey: CURSOR_HELP_WEB_API_KEY,
        llmModel: "auto",
        providerOptions: {
          targetTabId: 88,
          targetSite: "cursor_help"
        },
        role: "worker",
        llmTimeoutMs: 120000,
        llmRetryMaxAttempts: 2,
        llmMaxRetryDelayMs: 60000
      }
    ];

    const result = resolveLlmRoute({ config });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.provider).toBe("cursor_help_web");
    expect(result.route.llmBase).toBe(CURSOR_HELP_WEB_BASE_URL);
    expect(result.route.llmKey).toBe(CURSOR_HELP_WEB_API_KEY);
    expect(result.route.providerOptions).toMatchObject({
      targetTabId: 88,
      targetSite: "cursor_help"
    });
  });
});
