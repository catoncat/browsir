// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

import McpSettingsView from "../McpSettingsView.vue";
import { normalizePanelConfig, useConfigStore } from "../../stores/config-store";

const mountedViews: Array<() => void> = [];

function flushUi(): Promise<void> {
  return Promise.resolve().then(() => nextTick());
}

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);

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
  store.error = "";
  store.savingConfig = false;
  store.saveConfig = vi.fn().mockResolvedValue(undefined);

  const closeSpy = vi.fn();
  const root = document.createElement("div");
  document.body.appendChild(root);

  const app = createApp(McpSettingsView, {
    onClose: closeSpy,
  });
  app.use(pinia);
  app.mount(root);
  await flushUi();

  const unmount = () => {
    app.unmount();
    root.remove();
  };
  mountedViews.push(unmount);

  return { root, store, closeSpy, unmount };
}

afterEach(() => {
  while (mountedViews.length > 0) {
    mountedViews.pop()?.();
  }
  vi.restoreAllMocks();
});

describe("McpSettingsView", () => {
  it("saves MCP server config from the dedicated page", async () => {
    const view = await mountView();

    expect(view.root.textContent || "").toContain("MCP 服务器");

    const saveButton = Array.from(view.root.querySelectorAll("button")).find(
      (button) => (button.textContent || "").includes("保存并应用"),
    ) as HTMLButtonElement | undefined;
    expect(saveButton).toBeDefined();

    saveButton?.click();
    await flushUi();

    expect(view.store.saveConfig).toHaveBeenCalledTimes(1);
    expect(view.closeSpy).toHaveBeenCalledTimes(1);
  });
});
