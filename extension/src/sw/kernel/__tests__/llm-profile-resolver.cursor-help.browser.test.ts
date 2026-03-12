import { describe, expect, it } from "vitest";
import { resolveLlmRoute } from "../llm-profile-resolver";

describe("llm-profile-resolver cursor_help_web", () => {
  it("allows cursor_help_web profiles without llmApiBase/llmApiKey", () => {
    const result = resolveLlmRoute({
      config: {
        bridgeUrl: "ws://127.0.0.1:8787/ws",
        bridgeToken: "dev-token",
        browserRuntimeStrategy: "host-first",
        llmDefaultProfile: "cursor-help",
        llmProfiles: [
          {
            id: "cursor-help",
            provider: "cursor_help_web",
            llmApiBase: "",
            llmApiKey: "",
            llmModel: "cursor-help-web",
            providerOptions: {
              targetTabId: 88,
              targetSite: "cursor_help"
            },
            role: "worker",
            llmTimeoutMs: 120000,
            llmRetryMaxAttempts: 2,
            llmMaxRetryDelayMs: 60000
          }
        ],
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
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.provider).toBe("cursor_help_web");
    expect(result.route.providerOptions).toMatchObject({
      targetTabId: 88,
      targetSite: "cursor_help"
    });
  });
});
