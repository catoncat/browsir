import "./test-setup";

import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../runtime-infra.browser";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../shared/compaction";
import {
  buildLlmFailureSignature,
  extractRetryDelayHintMs,
  parseRetryAfterHeaderValue,
  readSessionLlmRoutePrefs,
  resolveAuxiliaryLlmRoute,
  resolveAuxiliaryNonHostedLlmRoute,
} from "../loop-llm-route";

type TestBridgeConfig = BridgeConfig & {
  llmProfiles?: unknown;
};

function baseConfig(): TestBridgeConfig {
  return {
    bridgeUrl: "ws://127.0.0.1:8787/ws",
    bridgeToken: "dev-token",
    browserRuntimeStrategy: "host-first",
    compaction: DEFAULT_COMPACTION_SETTINGS,
    llmDefaultProfile: "cursor-help",
    llmAuxProfile: "",
    llmFallbackProfile: "worker.pro",
    maxSteps: 10,
    autoTitleInterval: 10,
    bridgeInvokeTimeoutMs: 120000,
    llmTimeoutMs: 120000,
    llmRetryMaxAttempts: 2,
    llmMaxRetryDelayMs: 60000,
    devAutoReload: false,
    devReloadIntervalMs: 1500,
    llmProfiles: [
      {
        id: "cursor-help",
        provider: "cursor_help_web",
        llmApiBase: "",
        llmApiKey: "",
        llmModel: "auto",
        providerOptions: {
          targetTabId: 88,
          targetSite: "cursor_help",
        },
      },
      {
        id: "worker.pro",
        provider: "openai_compatible",
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "k-pro",
        llmModel: "gpt-pro",
      },
    ],
  };
}

describe("loop-llm-route auxiliary route", () => {
  it("keeps hosted_chat for plain auxiliary route resolution", () => {
    const config = baseConfig();
    const resolved = resolveAuxiliaryLlmRoute(config as BridgeConfig);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.route.provider).toBe("cursor_help_web");
    expect(resolved.route.runtimeKind).toBe("hosted_chat");
  });

  it("prefers non-hosted fallback for auxiliary internal requests", () => {
    const config = baseConfig();
    const resolved = resolveAuxiliaryNonHostedLlmRoute(
      config as BridgeConfig,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.route.profile).toBe("worker.pro");
    expect(resolved.route.provider).toBe("openai_compatible");
    expect(resolved.route.runtimeKind).toBe("model_llm");
  });

  it("returns hosted_chat when no non-hosted auxiliary profile exists", () => {
    const config = baseConfig();
    config.llmFallbackProfile = "";
    config.llmProfiles = [
      {
        id: "cursor-help",
        provider: "cursor_help_web",
        llmApiBase: "",
        llmApiKey: "",
        llmModel: "auto",
      },
    ];
    const resolved = resolveAuxiliaryNonHostedLlmRoute(
      config as BridgeConfig,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.route.provider).toBe("cursor_help_web");
    expect(resolved.route.runtimeKind).toBe("hosted_chat");
  });
});

describe("loop-llm-route shared helpers", () => {
  it("reads session route preferences from metadata", () => {
    expect(
      readSessionLlmRoutePrefs({
        header: {
          metadata: {
            llmProfile: "cursor-help",
            llmRole: "planner",
          },
        },
      }),
    ).toEqual({
      profile: "cursor-help",
      role: "planner",
    });

    expect(readSessionLlmRoutePrefs(null)).toEqual({
      profile: undefined,
      role: undefined,
    });
  });

  it("normalizes LLM failure signature", () => {
    expect(
      buildLlmFailureSignature({
        code: "e_timeout",
        status: 504,
        message: " Request Timed Out ",
      }),
    ).toBe("E_TIMEOUT|504|request timed out");
  });

  it("extracts retry delay hints from headers and body", () => {
    expect(parseRetryAfterHeaderValue("2")).toBe(2000);

    const headerResponse = new Response("{}", {
      headers: {
        "retry-after": "3",
      },
    });
    expect(extractRetryDelayHintMs("", headerResponse)).toBe(3000);

    const bodyResponse = new Response('{"error":"rate_limit"}');
    expect(
      extractRetryDelayHintMs('{"retryDelay":"1.5s"}', bodyResponse),
    ).toBe(1500);
  });
});
