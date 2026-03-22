// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineComponent, nextTick, ref } from "vue";

import McpServerSettingsSection from "../McpServerSettingsSection.vue";
import type { McpServerConfig } from "../../../shared/mcp-config";

const mountedViews: Array<() => void> = [];

function flushUi(): Promise<void> {
  return Promise.resolve().then(() => nextTick());
}

async function mountSection(initial: McpServerConfig[] = []) {
  const servers = ref<McpServerConfig[]>(initial);
  const root = document.createElement("div");
  document.body.appendChild(root);

  const App = defineComponent({
    components: {
      McpServerSettingsSection,
    },
    setup() {
      return {
        servers,
      };
    },
    template: `
      <McpServerSettingsSection v-model="servers" />
    `,
  });

  const app = createApp(App);
  app.mount(root);
  await flushUi();

  const unmount = () => {
    app.unmount();
    root.remove();
  };
  mountedViews.push(unmount);

  return {
    root,
    servers,
    unmount,
  };
}

afterEach(() => {
  while (mountedViews.length > 0) {
    mountedViews.pop()?.();
  }
});

describe("McpServerSettingsSection", () => {
  it("adds a server and lets the user switch from local command to remote url", async () => {
    const view = await mountSection();

    const addButton = view.root.querySelector(
      "button[data-mcp-add]",
    ) as HTMLButtonElement | null;
    expect(addButton).not.toBeNull();
    addButton?.click();
    await flushUi();

    const labelInput = view.root.querySelector(
      'input[data-mcp-field="label-0"]',
    ) as HTMLInputElement | null;
    const commandInput = view.root.querySelector(
      'input[data-mcp-field="command-0"]',
    ) as HTMLInputElement | null;
    expect(labelInput).not.toBeNull();
    expect(commandInput).not.toBeNull();

    labelInput!.value = "GitHub";
    labelInput!.dispatchEvent(new Event("input", { bubbles: true }));
    commandInput!.value = "bun";
    commandInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const remoteButton = view.root.querySelector(
      'button[data-mcp-transport="streamable-http-0"]',
    ) as HTMLButtonElement | null;
    expect(remoteButton).not.toBeNull();
    remoteButton?.click();
    await flushUi();

    const urlInput = view.root.querySelector(
      'input[data-mcp-field="url-0"]',
    ) as HTMLInputElement | null;
    expect(urlInput).not.toBeNull();
    urlInput!.value = "https://mcp.example.com";
    urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const enabledInput = view.root.querySelector(
      'input[data-mcp-enabled="0"]',
    ) as HTMLInputElement | null;
    expect(enabledInput).not.toBeNull();
    enabledInput!.checked = false;
    enabledInput!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushUi();

    expect(
      view.root.querySelector('input[data-mcp-field="envRef-0"]'),
    ).toBeNull();
    expect(
      view.root.querySelector('input[data-mcp-field="authRef-0"]'),
    ).toBeNull();

    expect(view.servers.value).toHaveLength(1);
    expect(view.servers.value[0]).toMatchObject({
      label: "GitHub",
      enabled: false,
      transport: "streamable-http",
      url: "https://mcp.example.com",
    });
  });
});
