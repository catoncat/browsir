// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

import ProviderSettingsView from "../ProviderSettingsView.vue";
import {
  normalizePanelConfig,
  useConfigStore,
  type BuiltinFreeCatalog,
  type PanelConfigNew,
} from "../../stores/config-store";
import {
  ADD_CUSTOM_PROVIDER_OPTION_VALUE,
  createSceneModelValue,
} from "../../utils/provider-settings-state";

interface MountedView {
  closeSpy: ReturnType<typeof vi.fn>;
  root: HTMLDivElement;
  store: ReturnType<typeof useConfigStore>;
  unmount: () => void;
}

const mountedViews: Array<() => void> = [];

function flushUi(): Promise<void> {
  return Promise.resolve().then(() => nextTick());
}

async function mountView(options?: {
  config?: PanelConfigNew;
  builtinFreeCatalog?: BuiltinFreeCatalog;
  loadBuiltinFreeCatalogImpl?: () => Promise<void>;
}): Promise<MountedView> {
  const pinia = createPinia();
  setActivePinia(pinia);

  const store = useConfigStore();
  store.config = options?.config || normalizePanelConfig({});
  store.builtinFreeCatalog =
    options?.builtinFreeCatalog || {
      selectedModel: "gpt-5",
      availableModels: ["gpt-5"],
    };
  store.error = "";
  store.savingConfig = false;
  store.loadBuiltinFreeCatalog = vi
    .fn(options?.loadBuiltinFreeCatalogImpl || (async () => {}))
    .mockName("loadBuiltinFreeCatalog");
  store.saveConfig = vi.fn().mockResolvedValue(undefined);

  const closeSpy = vi.fn();
  const root = document.createElement("div");
  document.body.appendChild(root);

  const app = createApp(ProviderSettingsView, {
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

  return {
    closeSpy,
    root,
    store,
    unmount,
  };
}

function getSceneSelect(root: HTMLElement, scene: "primary" | "aux" | "fallback") {
  const select = root.querySelector(
    `select[data-scene="${scene}"]`,
  ) as HTMLSelectElement | null;
  expect(select).not.toBeNull();
  return select as HTMLSelectElement;
}

function getOptionLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) =>
    (option.textContent || "").trim(),
  );
}

function getModelCheckbox(root: HTMLElement, modelId: string) {
  const checkbox = root.querySelector(
    `input[data-provider-model="${modelId}"]`,
  ) as HTMLInputElement | null;
  expect(checkbox).not.toBeNull();
  return checkbox as HTMLInputElement;
}

afterEach(() => {
  while (mountedViews.length > 0) {
    mountedViews.pop()?.();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProviderSettingsView", () => {
  it("renders builtin free as the default scene model without showing generic provider", async () => {
    const view = await mountView();
    const primary = getSceneSelect(view.root, "primary");

    expect(primary.value).toBe(createSceneModelValue("cursor_help_web", "gpt-5"));
    expect(getOptionLabels(primary)).toEqual([
      "请选择模型",
      "内置免费 / gpt-5",
      "+ 添加自定义服务商",
    ]);
    expect(view.root.textContent || "").not.toContain("通用 API");
  });

  it("opens add-provider sheet from the select action without changing current scene value", async () => {
    const view = await mountView();
    const primary = getSceneSelect(view.root, "primary");
    const initialValue = primary.value;

    primary.value = ADD_CUSTOM_PROVIDER_OPTION_VALUE;
    primary.dispatchEvent(new Event("change", { bubbles: true }));
    await flushUi();

    expect(view.root.textContent || "").toContain("添加自定义服务商");

    const backButton = view.root.querySelector(
      'button[aria-label="返回模型设置"]',
    ) as HTMLButtonElement | null;
    expect(backButton).not.toBeNull();
    backButton?.click();
    await flushUi();

    expect(getSceneSelect(view.root, "primary").value).toBe(initialValue);
  });

  it("adds provider models back into the scene options without auto-switching the scene", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            data: [{ id: "gpt-4.1" }, { id: "gpt-4o-mini" }],
          }),
      }),
    );

    const view = await mountView();
    const initialValue = getSceneSelect(view.root, "primary").value;

    const primary = getSceneSelect(view.root, "primary");
    primary.value = ADD_CUSTOM_PROVIDER_OPTION_VALUE;
    primary.dispatchEvent(new Event("change", { bubbles: true }));
    await flushUi();

    const providerName = view.root.querySelector(
      'input[data-provider-field="name"]',
    ) as HTMLInputElement | null;
    const apiBase = view.root.querySelector(
      'input[data-provider-field="api-base"]',
    ) as HTMLInputElement | null;
    const apiKey = view.root.querySelector(
      'input[data-provider-field="api-key"]',
    ) as HTMLInputElement | null;

    expect(providerName).not.toBeNull();
    expect(apiBase).not.toBeNull();
    expect(apiKey).not.toBeNull();

    providerName!.value = "OpenRouter";
    providerName!.dispatchEvent(new Event("input", { bubbles: true }));
    apiBase!.value = "https://openrouter.ai/api/v1";
    apiBase!.dispatchEvent(new Event("input", { bubbles: true }));
    apiKey!.value = "sk-test";
    apiKey!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const discoverButton = Array.from(view.root.querySelectorAll("button")).find(
      (button) => (button.textContent || "").includes("连接并获取模型"),
    ) as HTMLButtonElement | undefined;
    expect(discoverButton).toBeDefined();
    discoverButton?.click();
    await flushUi();
    await flushUi();

    expect(getModelCheckbox(view.root, "gpt-4.1").checked).toBe(false);
    expect(getModelCheckbox(view.root, "gpt-4o-mini").checked).toBe(false);

    getModelCheckbox(view.root, "gpt-4.1").click();
    await flushUi();

    const addButton = Array.from(view.root.querySelectorAll("button")).find((button) =>
      (button.textContent || "").includes("保存服务商"),
    ) as HTMLButtonElement | undefined;
    expect(addButton).toBeDefined();
    addButton?.click();
    await flushUi();

    const labels = getOptionLabels(getSceneSelect(view.root, "primary"));
    expect(labels).toContain("OpenRouter / gpt-4.1");
    expect(labels).not.toContain("OpenRouter / gpt-4o-mini");
    expect(getSceneSelect(view.root, "primary").value).toBe(initialValue);
  });

  it("renders added providers on the model settings page and reopens them for editing", async () => {
    const view = await mountView({
      config: normalizePanelConfig({
        llmProviders: [
          {
            id: "openrouter",
            name: "rs",
            type: "model_llm",
            apiConfig: {
              apiBase: "https://ai.chen.rs/v1",
              apiKey: "sk-test",
              supportedModels: ["gpt-5-codex", "qwen3-coder-plus"],
            },
            builtin: false,
          },
        ],
        llmProfiles: [
          {
            id: "cursor_help_web",
            providerId: "cursor_help_web",
            modelId: "auto",
            timeoutMs: 120000,
            retryMaxAttempts: 2,
            maxRetryDelayMs: 60000,
            builtin: true,
          },
        ],
        llmDefaultProfile: "cursor_help_web",
      }),
    });

    expect(view.root.textContent || "").toContain("已添加服务商");
    expect(view.root.textContent || "").toContain("rs");
    expect(view.root.textContent || "").toContain("2 个模型");

    const manageButton = view.root.querySelector(
      'button[data-provider-manage="openrouter"]',
    ) as HTMLButtonElement | null;
    expect(manageButton).not.toBeNull();
    manageButton?.click();
    await flushUi();

    expect(view.root.textContent || "").toContain("编辑自定义服务商");
    expect(
      (
        view.root.querySelector('input[data-provider-field="name"]') as HTMLInputElement
      ).value,
    ).toBe("rs");
    expect(getModelCheckbox(view.root, "gpt-5-codex").checked).toBe(true);
    expect(getModelCheckbox(view.root, "qwen3-coder-plus").checked).toBe(true);
  });

  it("shows visible feedback when builtin free model loading fails", async () => {
    const view = await mountView({
      builtinFreeCatalog: {
        selectedModel: "",
        availableModels: [],
      },
      loadBuiltinFreeCatalogImpl: async () => {
        throw new Error("fetch failed");
      },
    });

    expect(view.root.textContent || "").toContain("内置免费模型加载失败");
  });

  it("shows visible feedback when builtin free model catalog is empty", async () => {
    const view = await mountView({
      builtinFreeCatalog: {
        selectedModel: "",
        availableModels: [],
      },
    });

    expect(view.root.textContent || "").toContain("内置免费当前不可用");
  });
});
