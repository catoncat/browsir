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

  it("reports runtime sync failures as already saved", async () => {
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
      if (type === "bridge.connect") {
        throw new Error("bridge offline");
      }
      if (type === "brain.debug.config") return {};
      return {};
    });

    await expect(store.saveConfig()).rejects.toThrow(
      "配置已保存，但运行时同步失败：bridge offline",
    );
    expect(store.error).toBe("配置已保存，但运行时同步失败：bridge offline");
    expect(sendMessageMock).toHaveBeenCalledWith("config.save", expect.any(Object));
    expect(sendMessageMock).toHaveBeenCalledWith("bridge.connect");
    expect(sendMessageMock).not.toHaveBeenCalledWith("brain.mcp.sync-config", {
      refresh: true,
    });
    expect(sendMessageMock).toHaveBeenCalledWith("brain.debug.config");
  });

  it("does not persist stripped secret fields in MCP server payload", async () => {
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
        },
      ],
    });

    sendMessageMock.mockImplementation(async (type: string) => {
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
          },
        ],
      }),
    });
  });
});
