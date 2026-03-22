import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { normalizePanelConfig, useConfigStore } from "../config-store";
import { sendMessage } from "../send-message";

vi.mock("../send-message", () => ({
  sendMessage: vi.fn(),
}));

describe("config-store saveConfig", () => {
  const sendMessageMock = vi.mocked(sendMessage);

  beforeEach(() => {
    setActivePinia(createPinia());
    sendMessageMock.mockReset();
  });

  it("syncs remote-only MCP config without requiring bridge.connect", async () => {
    const store = useConfigStore();
    store.config = normalizePanelConfig({
      mcpServers: [
        {
          id: "github",
          label: "GitHub",
          enabled: true,
          transport: "streamable-http",
          url: "https://mcp.example.com",
        },
      ],
    });

    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "config.save") return {};
      if (type === "brain.mcp.sync-config") return {};
      if (type === "brain.debug.config") return {};
      return {};
    });

    await expect(store.saveConfig()).resolves.toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledWith("config.save", expect.any(Object));
    expect(sendMessageMock).toHaveBeenCalledWith("brain.mcp.sync-config", {
      refresh: true,
    });
    expect(sendMessageMock).not.toHaveBeenCalledWith("bridge.connect");
    expect(sendMessageMock).toHaveBeenCalledWith("brain.debug.config");
  });

  it("reports stdio runtime sync failures as already saved", async () => {
    const store = useConfigStore();
    store.config = normalizePanelConfig({
      mcpServers: [
        {
          id: "local-bun",
          label: "Local Bun",
          enabled: true,
          transport: "stdio",
          command: "bun",
          args: ["./mcp.ts"],
        },
      ],
    });

    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "config.save") return {};
      if (type === "brain.mcp.sync-config") {
        throw new Error("bridge offline");
      }
      if (type === "brain.debug.config") return {};
      return {};
    });

    await expect(store.saveConfig()).rejects.toThrow(
      "配置已保存，但运行时同步失败：bridge offline",
    );
    expect(store.error).toBe("配置已保存，但运行时同步失败：bridge offline");
    expect(sendMessageMock).toHaveBeenCalledWith("brain.mcp.sync-config", {
      refresh: true,
    });
    expect(sendMessageMock).not.toHaveBeenCalledWith("bridge.connect");
  });

  it("persists MCP browser-first config fields", async () => {
    const store = useConfigStore();
    store.config = normalizePanelConfig({
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
          env: {
            APP_MODE: "browser",
          },
          envRef: "env/shared",
        },
      ],
      mcpRefs: {
        auth: {
          "secret/github_token": "Bearer demo",
        },
        env: {
          "env/shared": {
            API_BASE: "https://api.example.com",
          },
        },
      },
    });

    sendMessageMock.mockImplementation(async (type: string) => {
      if (type === "brain.mcp.sync-config") return {};
      if (type === "brain.debug.config") return {};
      return {};
    });

    await store.saveConfig();

    expect(sendMessageMock).toHaveBeenCalledWith("config.save", {
      payload: expect.objectContaining({
        mcpServers: [
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
            env: {
              APP_MODE: "browser",
            },
            envRef: "env/shared",
          },
        ],
        mcpRefs: {
          auth: {
            "secret/github_token": "Bearer demo",
          },
          env: {
            "env/shared": {
              API_BASE: "https://api.example.com",
            },
          },
        },
      }),
    });
  });
});
