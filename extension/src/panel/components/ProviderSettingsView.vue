<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import { ArrowLeft, Eye, EyeOff, HelpCircle, Loader2 } from "lucide-vue-next";
import {
  DEFAULT_PANEL_LLM_PROVIDER,
  useConfigStore,
  type PanelLlmProvider,
} from "../stores/config-store";
import {
  applyProviderSettingsDraft,
  collectProviderModelOptions,
  deriveManagedProviderId,
  deriveProviderSettingsDraft,
  resetToBuiltinCursor,
} from "../utils/provider-settings-state";

const emit = defineEmits(["close"]);
const store = useConfigStore();
const { config, savingConfig, error } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const localError = ref("");
const showApiKey = ref(false);
const discoveringModels = ref(false);
const advancedOpen = ref(false);
const managedProviderId = ref(DEFAULT_PANEL_LLM_PROVIDER);
const primaryModelId = ref("");
const auxModelId = ref("");
const fallbackModelId = ref("");

function trim(value: unknown): string {
  return String(value || "").trim();
}

function ensureManagedProviderRecord(): PanelLlmProvider {
  const id = trim(managedProviderId.value) || DEFAULT_PANEL_LLM_PROVIDER;
  let provider =
    config.value.llmProviders.find((item) => trim(item.id) === id) || null;
  if (!provider) {
    provider = {
      id,
      name: "通用 API",
      type: "model_llm",
      apiConfig: {
        apiBase: "",
        apiKey: "",
        supportedModels: [],
        supportsModelDiscovery: false,
      },
      options: {},
      builtin: id === DEFAULT_PANEL_LLM_PROVIDER,
    };
    config.value.llmProviders.push(provider);
  }
  if (!provider.apiConfig) {
    provider.apiConfig = {
      apiBase: "",
      apiKey: "",
      supportedModels: [],
      supportsModelDiscovery: false,
    };
  }
  return provider;
}

const visibleError = computed(() => localError.value || trim(error.value));
const managedProvider = computed(() => ensureManagedProviderRecord());
const managedApiConfig = computed(() => {
  const provider = managedProvider.value;
  if (!provider.apiConfig) {
    provider.apiConfig = {
      apiBase: "",
      apiKey: "",
      supportedModels: [],
      supportsModelDiscovery: false,
    };
  }
  return provider.apiConfig;
});
const modelOptions = computed(() =>
  collectProviderModelOptions(config.value, managedProviderId.value),
);
const hasPrimaryModel = computed(() => Boolean(trim(primaryModelId.value)));
const hasConnectionFields = computed(
  () =>
    Boolean(trim(managedApiConfig.value.apiBase)) ||
    Boolean(trim(managedApiConfig.value.apiKey)),
);
const hasCustomSelection = computed(
  () =>
    hasConnectionFields.value ||
    hasPrimaryModel.value ||
    Boolean(trim(auxModelId.value)) ||
    Boolean(trim(fallbackModelId.value)),
);
const connectionStatus = computed(() => {
  if (modelOptions.value.length > 0) {
    return `已获取 ${modelOptions.value.length} 个模型`;
  }
  if (hasConnectionFields.value) return "已填写连接信息";
  return "使用默认能力";
});
const providerHost = computed(() => {
  const apiBase = trim(managedApiConfig.value.apiBase);
  if (!apiBase) return "";
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase;
  }
});

function syncDraftFromConfig(): void {
  managedProviderId.value = deriveManagedProviderId(config.value);
  ensureManagedProviderRecord();
  const draft = deriveProviderSettingsDraft(config.value, managedProviderId.value);
  primaryModelId.value = draft.primaryModelId;
  auxModelId.value = draft.auxModelId;
  fallbackModelId.value = draft.fallbackModelId;
  advancedOpen.value = Boolean(draft.auxModelId || draft.fallbackModelId);
}

function dedupeModels(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const modelId = trim(value);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    out.push(modelId);
  }
  return out;
}

function buildModelsEndpoint(apiBase: string): string {
  return `${trim(apiBase).replace(/\/+$/, "")}/models`;
}

function parseModelList(payload: unknown): string[] {
  const row =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(row?.data)
      ? row?.data
      : Array.isArray(row?.models)
        ? row?.models
        : [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const modelId =
      item && typeof item === "object"
        ? trim((item as Record<string, unknown>).id || (item as Record<string, unknown>).name)
        : trim(item);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    out.push(modelId);
  }
  return out;
}

function extractErrorMessage(
  bodyText: string,
  status: number,
  statusText: string,
): string {
  const text = trim(bodyText);
  if (!text) return `获取模型失败：${status} ${statusText}`.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const direct = trim(parsed.message);
    if (direct) return direct;
    const nested =
      parsed.error && typeof parsed.error === "object"
        ? trim((parsed.error as Record<string, unknown>).message)
        : "";
    if (nested) return nested;
  } catch {
    // keep plain text fallback
  }
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

async function handleDiscoverModels(): Promise<void> {
  localError.value = "";
  const apiBase = trim(managedApiConfig.value.apiBase);
  const apiKey = trim(managedApiConfig.value.apiKey);
  if (!apiBase || !apiKey) {
    localError.value = "请先完整填写 API Base 和 API Key。";
    return;
  }

  discoveringModels.value = true;
  try {
    const response = await fetch(buildModelsEndpoint(apiBase), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        extractErrorMessage(bodyText, response.status, response.statusText),
      );
    }

    const payload = bodyText ? JSON.parse(bodyText) : {};
    const models = parseModelList(payload);
    if (models.length === 0) {
      throw new Error("没有从该服务返回可用模型。");
    }

    managedApiConfig.value.supportedModels = models;
    managedApiConfig.value.supportsModelDiscovery = true;
    managedApiConfig.value.defaultModel =
      trim(primaryModelId.value) || trim(managedApiConfig.value.defaultModel) || models[0];

    if (!models.includes(trim(primaryModelId.value))) {
      primaryModelId.value = trim(managedApiConfig.value.defaultModel) || models[0];
    }
    if (trim(auxModelId.value) && !models.includes(trim(auxModelId.value))) {
      auxModelId.value = "";
    }
    if (
      trim(fallbackModelId.value) &&
      !models.includes(trim(fallbackModelId.value))
    ) {
      fallbackModelId.value = "";
    }
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  } finally {
    discoveringModels.value = false;
  }
}

function clearCustomProviderSetup(): void {
  localError.value = "";
  managedApiConfig.value.apiBase = "";
  managedApiConfig.value.apiKey = "";
  managedApiConfig.value.defaultModel = undefined;
  managedApiConfig.value.supportedModels = [];
  primaryModelId.value = "";
  auxModelId.value = "";
  fallbackModelId.value = "";
  advancedOpen.value = false;
  resetToBuiltinCursor(config.value);
}

async function handleSave(): Promise<void> {
  localError.value = "";
  const apiBase = trim(managedApiConfig.value.apiBase);
  const apiKey = trim(managedApiConfig.value.apiKey);

  if (!hasCustomSelection.value) {
    resetToBuiltinCursor(config.value);
  } else {
    if (!apiBase || !apiKey) {
      localError.value = "请先完整填写 API Base 和 API Key。";
      return;
    }
    if (!trim(primaryModelId.value)) {
      localError.value = "请先获取模型并选择主模型。";
      return;
    }

    managedApiConfig.value.apiBase = apiBase;
    managedApiConfig.value.apiKey = apiKey;
    managedApiConfig.value.defaultModel = trim(primaryModelId.value);
    managedApiConfig.value.supportedModels = dedupeModels([
      ...(managedApiConfig.value.supportedModels || []),
      primaryModelId.value,
      auxModelId.value,
      fallbackModelId.value,
    ]);

    applyProviderSettingsDraft(
      config.value,
      {
        primaryModelId: primaryModelId.value,
        auxModelId: auxModelId.value,
        fallbackModelId: fallbackModelId.value,
      },
      managedProviderId.value,
    );
  }

  try {
    await store.saveConfig();
    emit("close");
  } catch {
    // store.error is rendered in footer
  }
}

onMounted(() => {
  syncDraftFromConfig();
  dialogRef.value?.focus();
});
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="模型设置"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="返回"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" aria-hidden="true" />
      </button>
      <h2 class="ml-2 font-bold text-[14px] text-ui-text tracking-tight">模型设置</h2>
    </header>

    <main class="flex-1 overflow-y-auto p-4 space-y-4">
      <section class="rounded-sm border border-ui-border bg-ui-surface/30 p-4 space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-1">
            <p class="text-[16px] font-semibold tracking-tight text-ui-text">默认能力已启用：Cursor</p>
            <p class="text-[12px] text-ui-text-muted leading-relaxed">
              你也可以接入自己的兼容服务，选定模型后让不同场景直接使用。
            </p>
          </div>
          <span class="relative group">
            <button
              type="button"
              aria-label="查看默认能力说明"
              class="rounded-full p-1 text-ui-text-muted/70 hover:text-ui-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <HelpCircle :size="14" aria-hidden="true" />
            </button>
            <span
              role="tooltip"
              class="pointer-events-none absolute right-0 top-full z-10 mt-2 w-56 rounded-sm border border-ui-border bg-ui-bg px-2.5 py-2 text-[11px] leading-relaxed text-ui-text opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              内置默认能力。某些场景会打开一个独立窗口来完成任务。
            </span>
          </span>
        </div>
      </section>

      <section class="rounded-sm border border-ui-border bg-ui-surface/30 p-4 space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-1">
            <h3 class="text-[15px] font-semibold tracking-tight text-ui-text">自定义兼容服务</h3>
            <p class="text-[12px] text-ui-text-muted leading-relaxed">
              填写一个 OpenAI-compatible 服务，系统会自动拉取模型列表。
            </p>
          </div>
          <span class="inline-flex items-center rounded-full border border-ui-border bg-ui-bg px-2.5 py-1 text-[11px] text-ui-text-muted">
            {{ connectionStatus }}
          </span>
        </div>

        <div class="space-y-1.5">
          <label class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">
            API Base
          </label>
          <input
            v-model="managedApiConfig.apiBase"
            type="text"
            autocomplete="off"
            class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            placeholder="https://your-api.example/v1"
          />
        </div>

        <div class="space-y-1.5">
          <label class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">
            API Key
          </label>
          <div class="relative">
            <input
              v-model="managedApiConfig.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              autocomplete="off"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 pr-10 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              placeholder="sk-..."
            />
            <button
              type="button"
              class="absolute inset-y-0 right-0 px-2.5 text-ui-text-muted hover:text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
              :aria-pressed="showApiKey"
              @click="showApiKey = !showApiKey"
            >
              <EyeOff v-if="showApiKey" :size="15" aria-hidden="true" />
              <Eye v-else :size="15" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center justify-center gap-2 rounded-sm bg-ui-text px-3 py-2 text-[13px] font-bold text-ui-bg hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            :disabled="discoveringModels"
            @click="void handleDiscoverModels()"
          >
            <Loader2 v-if="discoveringModels" class="animate-spin" :size="14" />
            {{ discoveringModels ? "获取中..." : "连接并获取模型" }}
          </button>

          <button
            v-if="hasCustomSelection"
            type="button"
            class="inline-flex items-center justify-center rounded-sm border border-ui-border px-3 py-2 text-[13px] text-ui-text hover:bg-ui-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            @click="clearCustomProviderSetup"
          >
            仅使用默认能力
          </button>
        </div>

        <p class="text-[11px] text-ui-text-muted/75">
          支持标准 OpenAI-compatible `/models` 接口。
          <span v-if="providerHost">{{ `当前服务：${providerHost}` }}</span>
        </p>

        <div v-if="modelOptions.length > 0" class="space-y-1.5 rounded-sm border border-ui-border bg-ui-bg/60 p-3">
          <label class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">
            主模型
          </label>
          <select
            v-model="primaryModelId"
            class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          >
            <option value="" disabled>请选择模型</option>
            <option v-for="model in modelOptions" :key="model" :value="model">
              {{ model }}
            </option>
          </select>
          <p class="text-[11px] text-ui-text-muted/75">
            这是主对话默认使用的模型。
          </p>
        </div>
      </section>

      <section class="rounded-sm border border-ui-border bg-ui-surface/30 p-4 space-y-3">
        <button
          type="button"
          class="w-full flex items-center justify-between gap-3 text-left"
          :aria-expanded="advancedOpen"
          @click="advancedOpen = !advancedOpen"
        >
          <div class="space-y-1">
            <h3 class="text-[14px] font-semibold tracking-tight text-ui-text">高级设置</h3>
            <p class="text-[12px] text-ui-text-muted leading-relaxed">
              如果同一服务里有多个模型，可以按场景分配给标题摘要和失败兜底。
            </p>
          </div>
          <span class="text-[11px] text-ui-text-muted">{{ advancedOpen ? "收起" : "展开" }}</span>
        </button>

        <div v-if="advancedOpen" class="grid grid-cols-1 gap-3 pt-1">
          <div v-if="!modelOptions.length" class="rounded-sm border border-dashed border-ui-border bg-ui-bg/50 px-3 py-2 text-[12px] text-ui-text-muted">
            先完成连接并获取模型，再分配其他场景。
          </div>

          <template v-else>
            <label class="space-y-1.5">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">
                标题与摘要
              </span>
              <select
                v-model="auxModelId"
                class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              >
                <option value="">跟随主模型</option>
                <option v-for="model in modelOptions" :key="`aux-${model}`" :value="model">
                  {{ model }}
                </option>
              </select>
            </label>

            <label class="space-y-1.5">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">
                失败兜底
              </span>
              <select
                v-model="fallbackModelId"
                class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              >
                <option value="">关闭</option>
                <option
                  v-for="model in modelOptions"
                  :key="`fallback-${model}`"
                  :value="model"
                >
                  {{ model }}
                </option>
              </select>
            </label>
          </template>
        </div>
      </section>
    </main>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="visibleError" class="text-[11px] text-red-500 mb-3 px-1">
        {{ visibleError }}
      </p>
      <button
        class="w-full bg-ui-text text-ui-bg py-2.5 rounded-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :disabled="savingConfig"
        @click="void handleSave()"
      >
        <Loader2 v-if="savingConfig" class="animate-spin" :size="16" />
        {{ savingConfig ? "保存中..." : "保存并生效" }}
      </button>
    </footer>
  </div>
</template>
