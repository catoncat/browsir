// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

import SettingsView from "../SettingsView.vue";
import { normalizePanelConfig, useConfigStore } from "../../stores/config-store";
import { useWechatStore } from "../../stores/wechat-store";

const mountedViews: Array<() => void> = [];

function flushUi(): Promise<void> {
  return Promise.resolve().then(() => nextTick());
}

async function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);

  const configStore = useConfigStore();
  configStore.config = normalizePanelConfig({});
  configStore.error = "";
  configStore.savingConfig = false;
  configStore.saveConfig = vi.fn().mockResolvedValue(undefined);

  const wechatStore = useWechatStore();
  wechatStore.state = {
    hostEpoch: "epoch-1",
    protocolVersion: "bbl.host.v1",
    enabled: false,
    login: {
      status: "logged_out",
      updatedAt: "2026-03-22T00:00:00.000Z",
    },
  };
  wechatStore.loading = false;
  wechatStore.error = "";
  wechatStore.ready = true;
  wechatStore.refresh = vi.fn().mockResolvedValue(undefined);
  wechatStore.connect = vi.fn().mockResolvedValue(undefined);
  wechatStore.disconnect = vi.fn().mockResolvedValue(undefined);

  const closeSpy = vi.fn();
  const root = document.createElement("div");
  document.body.appendChild(root);

  const app = createApp(SettingsView, {
    onClose: closeSpy,
  });
  app.use(pinia);
  app.mount(root);
  await flushUi();
  await flushUi();

  const unmount = () => {
    app.unmount();
    root.remove();
  };
  mountedViews.push(unmount);

  return { root, wechatStore, closeSpy, unmount };
}

afterEach(() => {
  while (mountedViews.length > 0) {
    mountedViews.pop()?.();
  }
  vi.restoreAllMocks();
});

describe("SettingsView", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("uses a single connect action for logged-out WeChat state", async () => {
    const view = await mountView();

    expect(view.root.textContent || "").toContain("连接微信");
    expect(view.root.textContent || "").not.toContain("启用微信通道");

    const buttons = Array.from(view.root.querySelectorAll("button"));
    const connectButton = buttons.find((button) =>
      (button.textContent || "").includes("连接微信"),
    ) as HTMLButtonElement | undefined;

    expect(connectButton).toBeDefined();
    connectButton?.click();
    await flushUi();

    expect(view.wechatStore.connect).toHaveBeenCalledTimes(1);
  });

  it("uses disconnect action as the only secondary button when enabled", async () => {
    const view = await mountView();
    view.wechatStore.state.enabled = true;
    view.wechatStore.state.login.status = "logged_in";
    await flushUi();

    expect(view.root.textContent || "").toContain("断开微信");
    expect(view.root.textContent || "").not.toContain("停用通道");
    expect(view.root.textContent || "").not.toContain("退出登录");

    const buttons = Array.from(view.root.querySelectorAll("button"));
    const disconnectButton = buttons.find((button) =>
      (button.textContent || "").includes("断开微信"),
    ) as HTMLButtonElement | undefined;

    expect(disconnectButton).toBeDefined();
    disconnectButton?.click();
    await flushUi();

    expect(view.wechatStore.disconnect).toHaveBeenCalledTimes(1);
  });

  it("shows reconnect copy for an error state without leaking host internals", async () => {
    const view = await mountView();
    view.wechatStore.state.enabled = true;
    view.wechatStore.state.login.status = "error";
    view.wechatStore.state.login.lastError = "二维码已过期";
    await flushUi();

    expect(view.root.textContent || "").toContain("微信连接异常");
    expect(view.root.textContent || "").toContain("重新连接微信");
    expect(view.root.textContent || "").not.toContain("host epoch");
    expect(view.root.textContent || "").not.toContain("已停用");
  });

  it("shows loading state before the first WeChat refresh completes", async () => {
    const view = await mountView();
    view.wechatStore.ready = false;
    await flushUi();

    expect(view.root.textContent || "").toContain("正在读取微信状态");
    expect(view.root.textContent || "").toContain("读取状态...");
    expect(view.root.textContent || "").not.toContain("已停用");
    expect(view.root.textContent || "").not.toContain("连接微信");
  });
});
