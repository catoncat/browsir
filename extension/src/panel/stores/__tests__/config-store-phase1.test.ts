import { describe, expect, it } from "vitest";

import {
  normalizePanelConfig,
  type PanelConfigNew,
} from "../config-store";

describe("config-store target-state config", () => {
  describe("normalizePanelConfig", () => {
    it("defaults to builtin free and does not inject generic openai-compatible provider", () => {
      const result = normalizePanelConfig({});

      expect(result.llmDefaultProfile).toBe("cursor_help_web");
      expect(result.llmAuxProfile).toBe("");
      expect(result.llmFallbackProfile).toBe("");
      expect(result.llmProviders.map((item) => item.id)).toEqual([
        "cursor_help_web",
      ]);
      expect(result.llmProfiles.map((item) => item.id)).toEqual([
        "cursor_help_web",
      ]);
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

      expect(result.llmDefaultProfile).toBe("cursor_help_web");
      expect(result.llmAuxProfile).toBe("");
      expect(result.llmFallbackProfile).toBe("fallback");
      expect(result.llmProviders.map((item) => item.id)).toEqual(
        expect.arrayContaining(["shared-openai", "cursor_help_web"]),
      );
      expect(result.llmProfiles.map((item) => item.id)).toEqual(
        expect.arrayContaining(["fallback", "cursor_help_web"]),
      );
    });

    it("canonicalizes interrupted built-in cursor profile ids", () => {
      const result = normalizePanelConfig({
        llmDefaultProfile: "built-in",
        llmProviders: [
          {
            id: "cursor_help_web",
            name: "内置模型",
            type: "hosted_chat",
            builtin: true,
          },
        ],
        llmProfiles: [
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

    it("normalizes and preserves MCP servers", () => {
      const normalized = normalizePanelConfig({
        mcpServers: [
          {
            id: "GitHub Server",
            label: "GitHub",
            enabled: true,
            transport: "streamable-http",
            url: "https://mcp.example.com",
            authRef: "secret/github_token",
            headers: {
              authorization: "Bearer demo",
            },
          },
          {
            label: "Filesystem",
            enabled: false,
            transport: "stdio",
            command: "bun",
            args: ["run", "start"],
            cwd: "/tmp/fs",
          },
        ],
      });

      expect(normalized.mcpServers).toEqual([
        {
          id: "github_server",
          label: "GitHub",
          enabled: true,
          transport: "streamable-http",
          url: "https://mcp.example.com",
          authRef: "secret/github_token",
          headers: {
            authorization: "Bearer demo",
          },
        },
        {
          id: "filesystem",
          label: "Filesystem",
          enabled: false,
          transport: "stdio",
          command: "bun",
          args: ["run", "start"],
          cwd: "/tmp/fs",
        },
      ]);
    });
  });

  it("retains provider/profile associations in the stored config shape", () => {
    const config: PanelConfigNew = normalizePanelConfig({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      bridgeToken: "token-abc",
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
    });

    expect(config.llmDefaultProfile).toBe("writer");
    expect(config.llmProviders.find((item) => item.id === "shared-openai")?.apiConfig)
      .toMatchObject({
        apiBase: "https://api.openai.com/v1",
        apiKey: "sk-test-key",
        defaultModel: "gpt-4.1",
      });
    expect(config.llmProfiles.find((item) => item.id === "writer")).toMatchObject({
      providerId: "shared-openai",
      modelId: "gpt-4.1",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      stop: ["</END>"],
    });
  });
});
