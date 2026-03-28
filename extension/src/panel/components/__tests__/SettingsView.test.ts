// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

import { HOST_PROTOCOL_VERSION } from "../../../sw/kernel/host-protocol";
import SettingsView from "../SettingsView.vue";
import { normalizePanelConfig, useConfigStore } from "../../stores/config-store";
import { useBackupStore } from "../../stores/backup-store";
import { useWechatStore, type WechatPanelState } from "../../stores/wechat-store";

const mountedViews: Array<() => void> = [];

function buildWechatState(
  patch: {
    hostEpoch?: string;
    protocolVersion?: WechatPanelState["protocolVersion"];
    enabled?: boolean;
    auth?: Partial<WechatPanelState["auth"]>;
    transport?: Partial<WechatPanelState["transport"]>;
    resume?: Partial<WechatPanelState["resume"]>;
  } = {},
): WechatPanelState {
  return {
    hostEpoch: patch.hostEpoch ?? "epoch-1",
    protocolVersion: patch.protocolVersion ?? HOST_PROTOCOL_VERSION,
    enabled: patch.enabled ?? false,
    auth: {
      status: "logged_out",
      updatedAt: "2026-03-22T00:00:00.000Z",
      ...patch.auth,
    } as WechatPanelState["auth"],
    transport: {
      status: "stopped",
      updatedAt: "2026-03-22T00:00:00.000Z",
      resumable: false,
      consecutiveFailures: 0,
      ...patch.transport,
    } as WechatPanelState["transport"],
    resume: {
      resumable: false,
      ...patch.resume,
    } as WechatPanelState["resume"],
  };
}

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
  configStore.loadConfig = vi.fn().mockResolvedValue(undefined);
  configStore.refreshHealth = vi.fn().mockResolvedValue(undefined);
  configStore.loadBuiltinFreeCatalog = vi.fn().mockResolvedValue(undefined);
  configStore.saveConfig = vi.fn().mockResolvedValue(undefined);

  const backupStore = useBackupStore();
  backupStore.exporting = false;
  backupStore.importing = false;
  backupStore.error = "";
  backupStore.exportBackup = vi.fn().mockResolvedValue({
    schemaVersion: "bbl.extension-data.v1",
    exportedAt: "2026-03-27T00:00:00.000Z",
    payload: {
      config: normalizePanelConfig({}),
      skills: [],
    },
  });
  backupStore.importBackup = vi.fn().mockResolvedValue({
    importedAt: "2026-03-27T00:00:00.000Z",
    importedSkillIds: [],
    removedSkillIds: [],
  });

  const wechatStore = useWechatStore();
  wechatStore.state = buildWechatState();
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

  return { root, wechatStore, backupStore, configStore, closeSpy, unmount };
}

afterEach(() => {
  while (mountedViews.length > 0) {
    mountedViews.pop()?.();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("uses disconnect action as the only secondary button when healthy", async () => {
    const view = await mountView();
    view.wechatStore.state = buildWechatState({
      enabled: true,
      auth: {
        status: "authenticated",
        accountId: "bot-1",
        botUserId: "user-1",
      },
      transport: {
        status: "healthy",
        resumable: true,
      },
      resume: {
        resumable: true,
      },
    });
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

  it("shows reconnect copy for a reauth-required state without leaking host internals", async () => {
    const view = await mountView();
    view.wechatStore.state = buildWechatState({
      enabled: true,
      auth: {
        status: "reauth_required",
        lastError: "二维码已过期",
      },
    });
    await flushUi();

    expect(view.root.textContent || "").toContain("微信需要重新登录");
    expect(view.root.textContent || "").toContain("重新登录微信");
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

  it("exports backup from the settings page", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:backup"),
      revokeObjectURL: vi.fn(),
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const view = await mountView();

    const exportButton = Array.from(view.root.querySelectorAll("button")).find(
      (button) => (button.textContent || "").includes("导出备份"),
    ) as HTMLButtonElement | undefined;
    expect(exportButton).toBeDefined();
    exportButton?.click();
    await flushUi();

    expect(view.backupStore.exportBackup).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("imports backup and refreshes config state", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const view = await mountView();

    const input = view.root.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    if (!input) return;
    const file = new File(
      [
        JSON.stringify({
          schemaVersion: "bbl.extension-data.v1",
          exportedAt: "2026-03-27T00:00:00.000Z",
          payload: {
            config: normalizePanelConfig({}),
            skills: [],
          },
        }),
      ],
      "backup.json",
      { type: "application/json" },
    );
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });

    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushUi();
    await flushUi();

    expect(view.backupStore.importBackup).toHaveBeenCalledTimes(1);
    expect(view.configStore.loadConfig).toHaveBeenCalledTimes(1);
    expect(view.configStore.refreshHealth).toHaveBeenCalledTimes(1);
    expect(view.configStore.loadBuiltinFreeCatalog).toHaveBeenCalledTimes(1);
  });
});
