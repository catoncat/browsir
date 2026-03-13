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
    llmProfiles: [],
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
