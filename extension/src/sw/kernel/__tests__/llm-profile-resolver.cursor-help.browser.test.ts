import "./test-setup";

import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../llm-profile-resolver";
import type { BridgeConfig } from "../runtime-infra.browser";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../shared/compaction";

function baseConfig(): BridgeConfig {
  return {
    bridgeUrl: "ws://127.0.0.1:8787/ws",
    bridgeToken: "dev-token",
    browserRuntimeStrategy: "host-first",
    compaction: DEFAULT_COMPACTION_SETTINGS,
    llmDefaultProfile: "cursor-help",
    llmAuxProfile: "",
    llmFallbackProfile: "",
    llmProviders: [
      {
        id: "cursor_help_web",
        name: "内置模型",
        type: "hosted_chat",
        options: {
          targetTabId: 88,
          targetSite: "cursor_help",
        },
        builtin: true,
      },
    ],
    llmProfiles: [],
    mcpServers: [],
    mcpRefs: {},
    llmSystemPromptCustom: "",
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
  it("accepts cursor_help_web profiles without base/key pseudo config", () => {
    const config = baseConfig();
    config.llmProfiles = [
      {
        id: "cursor-help",
        providerId: "cursor_help_web",
        modelId: "auto",
        timeoutMs: 120000,
        retryMaxAttempts: 2,
        maxRetryDelayMs: 60000,
        builtin: false,
      }
    ];

    const result = resolveLlmRoute({ config });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.provider).toBe("cursor_help_web");
    expect(result.route.runtimeKind).toBe("hosted_chat");
    expect(result.route.llmBase).toBe("");
    expect(result.route.llmKey).toBe("");
    expect(result.route.providerOptions).toMatchObject({
      targetTabId: 88,
      targetSite: "cursor_help"
    });
  });
});
