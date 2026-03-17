<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import { ArrowLeft, Eye, EyeOff, Loader2, Plus } from "lucide-vue-next";
import {
  normalizePanelConfig,
  useConfigStore,
  type PanelConfigNew,
} from "../stores/config-store";
import {
  ADD_CUSTOM_PROVIDER_OPTION_VALUE,
  applySceneModelDraft,
  collectSceneModelOptions,
  deriveSceneModelDraft,
  upsertCustomProvider,
} from "../utils/provider-settings-state";

const emit = defineEmits(["close"]);
const store = useConfigStore();
const { config, savingConfig, error, builtinFreeCatalog } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const draftConfig = ref<PanelConfigNew>(normalizePanelConfig({}));
const localError = ref("");
const builtinFreeError = ref("");
const refreshingBuiltinFreeCatalog = ref(false);
const addProviderOpen = ref(false);
const discoveringModels = ref(false);
const showApiKey = ref(false);
const sceneSelectionDirty = ref(false);

const primaryValue = ref("");
const auxValue = ref("");
const fallbackValue = ref("");

const providerNameInput = ref("");
const apiBaseInput = ref("");
const apiKeyInput = ref("");
const discoveredModels = ref<string[]>([]);

function trim(value: unknown): string {
  return String(value || "").trim();
}

function clonePanelConfig(source: PanelConfigNew): PanelConfigNew {
  return normalizePanelConfig(
    JSON.parse(JSON.stringify(source)) as Record<string, unknown>,
  );
}

function dedupeModels(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = trim(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function buildModelsEndpoint(apiBase: string): string {
  return `${trim(apiBase).replace(/\/+$/, "")}/models`;
}

function parseModelList(payload: unknown): string[] {
  const row =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(row?.data)
      ? row.data
      : Array.isArray(row?.models)
        ? row.models
        : [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const modelId =
      item && typeof item === "object"
        ? trim(
            (item as Record<string, unknown>).id ||
              (item as Record<string, unknown>).name,
          )
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
    // Keep plain text fallback.
  }
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function syncSceneDraft(): void {
  const draft = deriveSceneModelDraft(draftConfig.value, builtinFreeCatalog.value);
  primaryValue.value = draft.primaryValue;
  auxValue.value = draft.auxValue;
  fallbackValue.value = draft.fallbackValue;
}

async function refreshBuiltinFreeCatalog(forceRefresh = false): Promise<void> {
  if (refreshingBuiltinFreeCatalog.value) return;
  refreshingBuiltinFreeCatalog.value = true;
  builtinFreeError.value = "";
  try {
    await store.loadBuiltinFreeCatalog({ forceRefresh });
  } catch (err) {
    const detail = trim(err instanceof Error ? err.message : String(err));
    builtinFreeError.value = detail
      ? `内置免费模型加载失败：${detail}`
      : "内置免费模型加载失败，请稍后重试。";
  } finally {
    if (!sceneSelectionDirty.value) {
      syncSceneDraft();
    }
    dialogRef.value?.focus();
    refreshingBuiltinFreeCatalog.value = false;
  }
}

function resetAddProviderDraft(): void {
  providerNameInput.value = "";
  apiBaseInput.value = "";
  apiKeyInput.value = "";
  discoveredModels.value = [];
  showApiKey.value = false;
}

function openAddProviderSheet(): void {
  localError.value = "";
  addProviderOpen.value = true;
}

function closeAddProviderSheet(): void {
  addProviderOpen.value = false;
  resetAddProviderDraft();
}

function handleSceneSelection(
  scene: "primary" | "aux" | "fallback",
  event: Event,
): void {
  const target = event.target as HTMLSelectElement | null;
  const nextValue = trim(target?.value);
  if (!target) return;

  if (nextValue === ADD_CUSTOM_PROVIDER_OPTION_VALUE) {
    if (scene === "primary") target.value = primaryValue.value;
    if (scene === "aux") target.value = auxValue.value;
    if (scene === "fallback") target.value = fallbackValue.value;
    openAddProviderSheet();
    return;
  }

  localError.value = "";
  sceneSelectionDirty.value = true;
  if (scene === "primary") primaryValue.value = nextValue;
  if (scene === "aux") auxValue.value = nextValue;
  if (scene === "fallback") fallbackValue.value = nextValue;
}

async function handleDiscoverModels(): Promise<void> {
  localError.value = "";
  const providerName = trim(providerNameInput.value);
  const apiBase = trim(apiBaseInput.value);
  const apiKey = trim(apiKeyInput.value);

  if (!providerName) {
    localError.value = "请先填写服务商名称。";
    return;
  }
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

    discoveredModels.value = dedupeModels(models);
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  } finally {
    discoveringModels.value = false;
  }
}

function handleAddProvider(): void {
  localError.value = "";
  const providerName = trim(providerNameInput.value);
  const apiBase = trim(apiBaseInput.value);
  const apiKey = trim(apiKeyInput.value);

  if (!providerName) {
    localError.value = "请先填写服务商名称。";
    return;
  }
  if (!apiBase || !apiKey) {
    localError.value = "请先完整填写 API Base 和 API Key。";
    return;
  }
  if (discoveredModels.value.length <= 0) {
    localError.value = "请先连接并获取模型。";
    return;
  }

  upsertCustomProvider(draftConfig.value, {
    providerName,
    apiBase,
    apiKey,
    supportedModels: discoveredModels.value,
  });
  closeAddProviderSheet();
}

async function handleSave(): Promise<void> {
  localError.value = "";
  if (!trim(primaryValue.value)) {
    localError.value = "请先为主对话选择模型。";
    return;
  }

  applySceneModelDraft(draftConfig.value, {
    primaryValue: primaryValue.value,
    auxValue: auxValue.value,
    fallbackValue: fallbackValue.value,
  });
  config.value = clonePanelConfig(draftConfig.value);

  try {
    await store.saveConfig();
    emit("close");
  } catch {
    // store.error is rendered below.
  }
}

const visibleError = computed(() => localError.value || trim(error.value));
const builtinFreeStatus = computed(() => {
  if (builtinFreeError.value) return builtinFreeError.value;
  if (trim(builtinFreeCatalog.value.statusMessage)) {
    return trim(builtinFreeCatalog.value.statusMessage);
  }
  const availableModels = builtinFreeCatalog.value.availableModels;
  const selectedModel = trim(builtinFreeCatalog.value.selectedModel);
  if (availableModels.length > 0 || selectedModel) return "";
  return "内置免费当前不可用，尚未检测到可用模型。";
});
const builtinFreeStatusDetail = computed(() => {
  if (builtinFreeError.value) return "";
  return trim(builtinFreeCatalog.value.statusDetail);
});
const modelOptions = computed(() =>
  collectSceneModelOptions(draftConfig.value, builtinFreeCatalog.value),
);
const hasModelOptions = computed(() => modelOptions.value.length > 0);
const discoveredModelSummary = computed(() => {
  if (discoveredModels.value.length <= 0) return "";
  return `已获取 ${discoveredModels.value.length} 个模型`;
});

onMounted(() => {
  draftConfig.value = clonePanelConfig(config.value);
  syncSceneDraft();
  void refreshBuiltinFreeCatalog();
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
    @keydown.esc="addProviderOpen ? closeAddProviderSheet() : $emit('close')"
  >
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :aria-label="addProviderOpen ? '返回模型设置' : '返回'"
        @click="addProviderOpen ? closeAddProviderSheet() : $emit('close')"
      >
        <ArrowLeft :size="18" aria-hidden="true" />
      </button>
      <h2 class="ml-2 font-bold text-[14px] text-ui-text tracking-tight">
        {{ addProviderOpen ? "添加自定义服务商" : "模型设置" }}
      </h2>
    </header>

    <main v-if="!addProviderOpen" class="flex-1 overflow-y-auto p-4 space-y-4">
      <section
        v-if="builtinFreeStatus"
        class="rounded-sm border border-amber-500/30 bg-amber-500/8 p-3 flex items-start justify-between gap-3"
        aria-live="polite"
      >
        <p class="text-[12px] leading-relaxed text-amber-200">
          {{ builtinFreeStatus }}
        </p>
        <p
          v-if="builtinFreeStatusDetail"
          class="text-[11px] leading-relaxed text-amber-100/80"
        >
          {{ builtinFreeStatusDetail }}
        </p>
        <button
          type="button"
          class="shrink-0 rounded-sm border border-ui-border px-2.5 py-1.5 text-[12px] text-ui-text hover:bg-ui-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :disabled="refreshingBuiltinFreeCatalog"
          @click="void refreshBuiltinFreeCatalog(true)"
        >
          <Loader2
            v-if="refreshingBuiltinFreeCatalog"
            class="inline-block mr-1 animate-spin"
            :size="12"
            aria-hidden="true"
          />
          {{ refreshingBuiltinFreeCatalog ? "重试中..." : "重试" }}
        </button>
      </section>

      <section class="rounded-sm border border-ui-border bg-ui-surface/30 p-4 space-y-4">
        <label class="block space-y-1.5">
          <span class="block text-[13px] font-semibold text-ui-text">主对话</span>
          <select
            data-scene="primary"
            :value="primaryValue"
            class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            @change="handleSceneSelection('primary', $event)"
          >
            <option value="" disabled>
              {{ hasModelOptions ? "请选择模型" : "当前没有可用模型" }}
            </option>
            <option v-for="option in modelOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
            <option :value="ADD_CUSTOM_PROVIDER_OPTION_VALUE">+ 添加自定义服务商</option>
          </select>
        </label>

        <label class="block space-y-1.5">
          <span class="block text-[13px] font-semibold text-ui-text">标题与摘要</span>
          <select
            data-scene="aux"
            :value="auxValue"
            class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            @change="handleSceneSelection('aux', $event)"
          >
            <option value="">跟随主对话</option>
            <option
              v-for="option in modelOptions"
              :key="`aux-${option.value}`"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option :value="ADD_CUSTOM_PROVIDER_OPTION_VALUE">+ 添加自定义服务商</option>
          </select>
        </label>

        <label class="block space-y-1.5">
          <span class="block text-[13px] font-semibold text-ui-text">失败兜底</span>
          <select
            data-scene="fallback"
            :value="fallbackValue"
            class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            @change="handleSceneSelection('fallback', $event)"
          >
            <option value="">关闭</option>
            <option
              v-for="option in modelOptions"
              :key="`fallback-${option.value}`"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option :value="ADD_CUSTOM_PROVIDER_OPTION_VALUE">+ 添加自定义服务商</option>
          </select>
        </label>
      </section>
    </main>

    <main v-else class="flex-1 overflow-y-auto p-4 space-y-4">
      <section class="rounded-sm border border-ui-border bg-ui-surface/30 p-4 space-y-4">
        <div class="space-y-1">
          <h3 class="text-[15px] font-semibold tracking-tight text-ui-text">连接兼容服务</h3>
          <p class="text-[12px] text-ui-text-muted leading-relaxed">
            添加后只会把模型加入可选列表，不会自动改动当前场景。
          </p>
        </div>

        <div class="space-y-1.5">
          <label class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">
            服务商名称
          </label>
          <input
            v-model="providerNameInput"
            data-provider-field="name"
            type="text"
            autocomplete="off"
            class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            placeholder="例如 OpenRouter"
          />
        </div>

        <div class="space-y-1.5">
          <label class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">
            API Base
          </label>
          <input
            v-model="apiBaseInput"
            data-provider-field="api-base"
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
              v-model="apiKeyInput"
              data-provider-field="api-key"
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
            type="button"
            class="inline-flex items-center justify-center rounded-sm border border-ui-border px-3 py-2 text-[13px] text-ui-text hover:bg-ui-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            @click="closeAddProviderSheet"
          >
            返回
          </button>
        </div>

        <div
          v-if="discoveredModels.length > 0"
          class="rounded-sm border border-ui-border bg-ui-bg/60 p-3 space-y-2"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="text-[12px] font-semibold text-ui-text">{{ discoveredModelSummary }}</span>
            <button
              type="button"
              class="inline-flex items-center justify-center gap-1.5 rounded-sm border border-ui-border px-2.5 py-1.5 text-[12px] text-ui-text hover:bg-ui-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              @click="handleAddProvider"
            >
              <Plus :size="14" aria-hidden="true" />
              添加服务商
            </button>
          </div>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="model in discoveredModels"
              :key="model"
              class="inline-flex items-center rounded-full border border-ui-border bg-ui-bg px-2.5 py-1 text-[11px] text-ui-text-muted"
            >
              {{ model }}
            </span>
          </div>
        </div>
      </section>
    </main>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="visibleError" class="text-[11px] text-red-500 mb-3 px-1">
        {{ visibleError }}
      </p>
      <button
        v-if="!addProviderOpen"
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
