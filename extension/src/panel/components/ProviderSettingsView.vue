<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import {
  DEFAULT_PANEL_LLM_API_BASE,
  DEFAULT_PANEL_LLM_MODEL,
  DEFAULT_PANEL_LLM_PROVIDER,
  useRuntimeStore,
  type PanelLlmProfile,
} from "../stores/runtime";
import { ArrowLeft, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-vue-next";
import { normalizeProviderConnectionConfig } from "../../shared/llm-provider-config";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();
const { config, savingConfig, error } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const localError = ref("");
const showApiKeys = ref<Record<string, boolean>>({});
const bindingLoading = ref<Record<string, boolean>>({});

const defaultProfileId = "provider-default-profile";
const auxProfileId = "provider-aux-profile";
const fallbackProfileId = "provider-fallback-profile";
const CURSOR_WEB_PROFILE_ID = "cursor-web";
const CURSOR_HELP_URL = "https://cursor.com/help";
const CURSOR_TAB_PATTERNS = ["https://cursor.com/help*"] as const;
const builtinProviderOptions = [
  { value: "openai_compatible", label: "通用 API" },
  { value: "cursor_help_web", label: "Cursor" },
] as const;

const visibleError = computed(
  () => localError.value || String(error.value || ""),
);
const secondaryProfileOptions = computed(() => {
  const defaultProfile = String(config.value.llmDefaultProfile || "").trim();
  return config.value.llmProfiles.filter(
    (profile) => String(profile.id || "").trim() !== defaultProfile,
  );
});

function normalizeProfileId(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createUniqueProfileId(seed: string, taken: Set<string>): string {
  const base = normalizeProfileId(seed) || "profile";
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function providerOptions(profile: PanelLlmProfile): Record<string, unknown> {
  if (!profile.providerOptions || typeof profile.providerOptions !== "object") {
    profile.providerOptions = {};
  }
  return profile.providerOptions;
}

function isCursorHelpWebProvider(profile: PanelLlmProfile): boolean {
  return (
    String(profile.provider || "")
      .trim()
      .toLowerCase() === "cursor_help_web"
  );
}

function findCursorWebProfile(): PanelLlmProfile | null {
  return (
    config.value.llmProfiles.find((profile) =>
      isCursorHelpWebProvider(profile),
    ) || null
  );
}

function getProviderSelectOptions(
  profile: PanelLlmProfile,
): Array<{ value: string; label: string }> {
  const current = String(profile.provider || "").trim();
  if (!current) return [...builtinProviderOptions];
  if (builtinProviderOptions.some((item) => item.value === current)) {
    return [...builtinProviderOptions];
  }
  return [
    { value: current, label: `自定义接入 (${current})` },
    ...builtinProviderOptions,
  ];
}

function isDefaultProfile(profile: PanelLlmProfile): boolean {
  return (
    String(profile.id || "").trim() ===
    String(config.value.llmDefaultProfile || "").trim()
  );
}

function isAuxProfile(profile: PanelLlmProfile): boolean {
  return (
    String(profile.id || "").trim() ===
    String(config.value.llmAuxProfile || "").trim()
  );
}

function isFallbackProfile(profile: PanelLlmProfile): boolean {
  return (
    String(profile.id || "").trim() ===
    String(config.value.llmFallbackProfile || "").trim()
  );
}

function getProviderLabel(profile: PanelLlmProfile): string {
  const provider = String(profile.provider || "")
    .trim()
    .toLowerCase();
  if (provider === "cursor_help_web") return "Cursor";
  if (provider === "openai_compatible") return "通用 API";
  return String(profile.provider || "").trim() || "未设置接入方式";
}

function getProfileTitle(profile: PanelLlmProfile, index: number): string {
  return String(profile.id || "").trim() || `模型 ${index + 1}`;
}

function getProfileSummary(profile: PanelLlmProfile): string {
  if (isCursorHelpWebProvider(profile)) {
    return getCursorHelpTargetTabId(profile)
      ? "已连接 Cursor，会沿用当前页面的登录状态。"
      : "保存后会自动连接 Cursor。";
  }
  const model = String(profile.llmModel || "").trim() || "未设置模型";
  const base = String(profile.llmApiBase || "").trim() || "未设置接口地址";
  return `${model} · ${base}`;
}

function getProfileOptionLabel(profile: PanelLlmProfile): string {
  const id = String(profile.id || "").trim() || "未命名模型";
  const model = String(profile.llmModel || "").trim() || "未设置模型";
  return `${id} · ${getProviderLabel(profile)} · ${model}`;
}

function getCursorHelpTargetTabId(profile: PanelLlmProfile): number | "" {
  const raw = Number(providerOptions(profile).targetTabId);
  return Number.isInteger(raw) && raw > 0 ? raw : "";
}

function getCursorHelpDetectedModel(profile: PanelLlmProfile): string {
  return String(providerOptions(profile).detectedModel || "").trim();
}

function getCursorHelpAvailableModels(profile: PanelLlmProfile): string[] {
  const raw = providerOptions(profile).availableModels;
  return Array.isArray(raw)
    ? raw.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function getCursorHelpModelOptions(profile: PanelLlmProfile): string[] {
  const out = new Set<string>(["auto"]);
  const detected = getCursorHelpDetectedModel(profile);
  if (detected) out.add(detected);
  for (const model of getCursorHelpAvailableModels(profile)) {
    out.add(model);
  }
  return Array.from(out);
}

function setCursorHelpTargetTabId(
  profile: PanelLlmProfile,
  value: unknown,
): void {
  const options = providerOptions(profile);
  const raw = Number(value);
  if (Number.isInteger(raw) && raw > 0) {
    options.targetTabId = raw;
  } else {
    delete options.targetTabId;
  }
  options.targetSite = "cursor_help";
}

async function sendTabMessageWithRetry(
  tabId: number,
  message: Record<string, unknown>,
  retries = 12,
): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (errorValue) {
      lastError = errorValue;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || "标签页通信失败"));
}

async function inspectCursorTab(
  tabId: number,
): Promise<{ isReady: boolean; url: string } | null> {
  const response = await sendTabMessageWithRetry(tabId, {
    type: "webchat.inspect",
  }).catch(() => null);
  const row =
    response && typeof response === "object"
      ? (response as Record<string, unknown>)
      : null;
  if (!row || row.ok !== true) return null;
  return {
    isReady: row.isReady === true,
    url: String(row.url || ""),
  };
}

async function locateCursorChatTab(
  active: boolean,
): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: [...CURSOR_TAB_PATTERNS] });
  const sorted = [...tabs].sort((left, right) => {
    const leftHelp = String(left.url || "").startsWith(CURSOR_HELP_URL) ? 1 : 0;
    const rightHelp = String(right.url || "").startsWith(CURSOR_HELP_URL)
      ? 1
      : 0;
    return rightHelp - leftHelp;
  });
  for (const tab of sorted) {
    if (!tab.id) continue;
    const inspected = await inspectCursorTab(tab.id);
    if (!inspected?.isReady) continue;
    if (active) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {
        // noop
      });
      if (typeof tab.windowId === "number") {
        await chrome.windows
          .update(tab.windowId, { focused: true })
          .catch(() => {
            // noop
          });
      }
    }
    return tab;
  }
  return null;
}

async function openCursorFallbackTab(
  active: boolean,
): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({
    url: CURSOR_HELP_URL,
    active,
  });
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {
    // noop
  });
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
      // noop
    });
  }
}

async function bindCurrentTab(profile: PanelLlmProfile): Promise<void> {
  await ensureCursorHelpTab(profile, true);
}

async function ensureCursorHelpTab(
  profile: PanelLlmProfile,
  active: boolean,
): Promise<void> {
  const profileId = String(profile.id || "").trim();
  if (!profileId) return;
  bindingLoading.value = {
    ...bindingLoading.value,
    [profileId]: true,
  };
  localError.value = "";
  try {
    let boundTab = await locateCursorChatTab(active);

    if (!boundTab?.id) {
      boundTab = await openCursorFallbackTab(active);
    }

    if (!boundTab?.id) {
      throw new Error("未能打开 Cursor 页面");
    }
    await focusTab(boundTab);
    setCursorHelpTargetTabId(profile, boundTab.id);
    await inspectCursorHelpTab(profile, boundTab.id);
    const inspected = await inspectCursorTab(boundTab.id);
    if (!inspected?.isReady) {
      localError.value =
        "已打开 Cursor 页面，但暂时还不能使用。请等待页面加载完成后重试。";
    }
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  } finally {
    bindingLoading.value = {
      ...bindingLoading.value,
      [profileId]: false,
    };
  }
}

async function inspectCursorHelpTab(
  profile: PanelLlmProfile,
  tabId = Number(getCursorHelpTargetTabId(profile)),
): Promise<void> {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const response = await sendTabMessageWithRetry(tabId, {
    type: "webchat.inspect",
  }).catch(() => null);
  const row =
    response && typeof response === "object"
      ? (response as Record<string, unknown>)
      : {};
  const options = providerOptions(profile);
  const selectedModel = String(row.selectedModel || "").trim();
  const availableModels = Array.isArray(row.availableModels)
    ? row.availableModels
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  if (selectedModel) {
    options.detectedModel = selectedModel;
  } else {
    delete options.detectedModel;
  }
  if (availableModels.length > 0) {
    options.availableModels = availableModels;
  } else {
    delete options.availableModels;
  }
  if (!String(profile.llmModel || "").trim()) {
    profile.llmModel = "auto";
  }
}

async function handleProviderChange(profile: PanelLlmProfile): Promise<void> {
  if (!isCursorHelpWebProvider(profile)) return;
  const options = providerOptions(profile);
  options.targetSite = "cursor_help";
  if (
    !String(profile.llmModel || "").trim() ||
    String(profile.llmModel || "").trim() === DEFAULT_PANEL_LLM_MODEL
  ) {
    profile.llmModel = "auto";
  }
  await ensureCursorHelpTab(profile, true);
}

async function enableCursorWebPreset(): Promise<void> {
  localError.value = "";
  ensureProfiles();
  let profile = findCursorWebProfile();
  if (!profile) {
    const connection = normalizeProviderConnectionConfig({
      provider: "cursor_help_web",
      llmApiBase: "",
      llmApiKey: "",
    });
    profile = {
      id: CURSOR_WEB_PROFILE_ID,
      provider: "cursor_help_web",
      llmApiBase: connection.llmApiBase,
      llmApiKey: connection.llmApiKey,
      llmModel: "auto",
      providerOptions: {
        targetSite: "cursor_help",
      },
      llmTimeoutMs: 120000,
      llmRetryMaxAttempts: 1,
      llmMaxRetryDelayMs: 60000,
    };
    config.value.llmProfiles.unshift(profile);
  }
  profile.provider = "cursor_help_web";
  const connection = normalizeProviderConnectionConfig({
    provider: profile.provider,
    llmApiBase: profile.llmApiBase,
    llmApiKey: profile.llmApiKey,
  });
  profile.llmApiBase = connection.llmApiBase;
  profile.llmApiKey = connection.llmApiKey;
  profile.llmModel = String(profile.llmModel || "auto").trim() || "auto";
  providerOptions(profile).targetSite = "cursor_help";
  config.value.llmDefaultProfile = profile.id;
  ensureProfiles();
  await ensureCursorHelpTab(profile, true);
}

function buildDefaultProfile(idSeed: string): PanelLlmProfile {
  const id = normalizeProfileId(idSeed) || "profile-default";
  return {
    id,
    provider: DEFAULT_PANEL_LLM_PROVIDER,
    llmApiBase: DEFAULT_PANEL_LLM_API_BASE,
    llmApiKey: "",
    llmModel: DEFAULT_PANEL_LLM_MODEL,
    providerOptions: {},
    llmTimeoutMs: Number(config.value.llmTimeoutMs || 120000),
    llmRetryMaxAttempts: Number(config.value.llmRetryMaxAttempts || 2),
    llmMaxRetryDelayMs: Number(config.value.llmMaxRetryDelayMs || 60000),
  };
}

function nextProfileId(): string {
  const existing = new Set(
    config.value.llmProfiles.map((item) => String(item.id || "").trim()),
  );
  let index = config.value.llmProfiles.length + 1;
  while (existing.has(`profile-${index}`)) {
    index += 1;
  }
  return `profile-${index}`;
}

function sanitizeSelectedProfiles(): void {
  const validIds = new Set(
    config.value.llmProfiles
      .map((item) => String(item.id || "").trim())
      .filter(Boolean),
  );
  const firstId = String(config.value.llmProfiles[0]?.id || "").trim();
  const currentDefault = String(config.value.llmDefaultProfile || "").trim();
  const nextDefault = validIds.has(currentDefault)
    ? currentDefault
    : firstId || "default";
  config.value.llmDefaultProfile = nextDefault;

  const auxProfile = String(config.value.llmAuxProfile || "").trim();
  config.value.llmAuxProfile =
    auxProfile && auxProfile !== nextDefault && validIds.has(auxProfile)
      ? auxProfile
      : "";

  const fallbackProfile = String(config.value.llmFallbackProfile || "").trim();
  config.value.llmFallbackProfile =
    fallbackProfile &&
    fallbackProfile !== nextDefault &&
    validIds.has(fallbackProfile)
      ? fallbackProfile
      : "";
}

function ensureProfiles(): void {
  if (
    !Array.isArray(config.value.llmProfiles) ||
    config.value.llmProfiles.length === 0
  ) {
    config.value.llmProfiles = [buildDefaultProfile("default")];
  }
  sanitizeSelectedProfiles();
}

function toggleApiKey(profileId: string): void {
  const id = String(profileId || "").trim();
  if (!id) return;
  showApiKeys.value = {
    ...showApiKeys.value,
    [id]: !showApiKeys.value[id],
  };
}

function addProfile(): void {
  localError.value = "";
  ensureProfiles();
  config.value.llmProfiles.push(buildDefaultProfile(nextProfileId()));
}

function removeProfile(profileId: string): void {
  if (config.value.llmProfiles.length <= 1) {
    localError.value = "至少保留一个模型";
    return;
  }
  const id = String(profileId || "").trim();
  config.value.llmProfiles = config.value.llmProfiles.filter(
    (item) => String(item.id || "").trim() !== id,
  );
  ensureProfiles();
}

function normalizeProfilesBeforeSave(): void {
  const taken = new Set<string>();
  const normalized: PanelLlmProfile[] = [];
  const idMap = new Map<string, string>();

  for (const raw of config.value.llmProfiles) {
    const sourceId = String(raw.id || "").trim();
    const normalizedId = createUniqueProfileId(
      sourceId || nextProfileId(),
      taken,
    );
    taken.add(normalizedId);
    if (sourceId) {
      idMap.set(sourceId, normalizedId);
    }
    const provider =
      String(raw.provider || DEFAULT_PANEL_LLM_PROVIDER).trim() ||
      DEFAULT_PANEL_LLM_PROVIDER;
    const nextProviderOptions =
      raw.providerOptions && typeof raw.providerOptions === "object"
        ? { ...raw.providerOptions }
        : {};
    if (provider.toLowerCase() === "cursor_help_web") {
      nextProviderOptions.targetSite = "cursor_help";
    }
    const connection = normalizeProviderConnectionConfig({
      provider,
      llmApiBase: raw.llmApiBase,
      llmApiKey: raw.llmApiKey,
    });
    normalized.push({
      id: normalizedId,
      provider,
      llmApiBase: connection.llmApiBase,
      llmApiKey: connection.llmApiKey,
      llmModel:
        String(raw.llmModel || DEFAULT_PANEL_LLM_MODEL).trim() ||
        DEFAULT_PANEL_LLM_MODEL,
      providerOptions: nextProviderOptions,
      llmTimeoutMs: Math.max(1000, Number(raw.llmTimeoutMs || 120000)),
      llmRetryMaxAttempts: Math.max(
        0,
        Math.min(6, Number(raw.llmRetryMaxAttempts || 2)),
      ),
      llmMaxRetryDelayMs: Math.max(0, Number(raw.llmMaxRetryDelayMs || 60000)),
    });
  }

  config.value.llmProfiles =
    normalized.length > 0 ? normalized : [buildDefaultProfile("default")];

  const remapSelection = (value: string): string => {
    const id = String(value || "").trim();
    if (!id) return "";
    return idMap.get(id) || id;
  };

  config.value.llmDefaultProfile = remapSelection(
    config.value.llmDefaultProfile,
  );
  config.value.llmAuxProfile = remapSelection(config.value.llmAuxProfile);
  config.value.llmFallbackProfile = remapSelection(
    config.value.llmFallbackProfile,
  );
  ensureProfiles();
}

async function handleSave(): Promise<void> {
  localError.value = "";
  try {
    normalizeProfilesBeforeSave();
    for (const profile of config.value.llmProfiles) {
      if (
        isCursorHelpWebProvider(profile) &&
        !getCursorHelpTargetTabId(profile)
      ) {
        await ensureCursorHelpTab(profile, false);
      }
    }
    await store.saveConfig();
    emit("close");
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  ensureProfiles();
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
    <header
      class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0"
    >
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="返回"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" aria-hidden="true" />
      </button>
      <h2 class="ml-2 text-[13px] font-bold tracking-tight">模型设置</h2>
    </header>

    <main class="flex-1 overflow-y-auto p-4 space-y-4">
      <section
        class="border border-ui-border bg-ui-surface/30 p-4 rounded-sm space-y-3"
      >
        <div class="space-y-1">
          <p class="text-[16px] font-semibold tracking-tight text-ui-text">
            模型
          </p>
          <p class="text-[12px] text-ui-text-muted leading-relaxed">
            默认模型必选，其余按需设置。
          </p>
        </div>

        <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <label class="space-y-1.5">
            <span
              class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
              >默认模型</span
            >
            <select
              :id="defaultProfileId"
              v-model="config.llmDefaultProfile"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <option
                v-for="profile in config.llmProfiles"
                :key="profile.id"
                :value="profile.id"
              >
                {{ getProfileOptionLabel(profile) }}
              </option>
            </select>
            <p class="text-[11px] text-ui-text-muted/75">用于对话回复</p>
          </label>

          <label class="space-y-1.5">
            <span
              class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
              >标题与摘要</span
            >
            <select
              :id="auxProfileId"
              v-model="config.llmAuxProfile"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <option value="">使用默认模型</option>
              <option
                v-for="profile in secondaryProfileOptions"
                :key="profile.id"
                :value="profile.id"
              >
                {{ getProfileOptionLabel(profile) }}
              </option>
            </select>
            <p class="text-[11px] text-ui-text-muted/75">
              可选，用于自动生成标题和摘要
            </p>
          </label>

          <label class="space-y-1.5">
            <span
              class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
              >备用模型</span
            >
            <select
              :id="fallbackProfileId"
              v-model="config.llmFallbackProfile"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <option value="">不使用备用模型</option>
              <option
                v-for="profile in secondaryProfileOptions"
                :key="profile.id"
                :value="profile.id"
              >
                {{ getProfileOptionLabel(profile) }}
              </option>
            </select>
            <p class="text-[11px] text-ui-text-muted/75">
              可选，默认模型不可用时使用
            </p>
          </label>
        </div>
      </section>

      <section
        class="border border-ui-border bg-ui-surface/30 p-3 rounded-sm space-y-3"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-1">
            <h3
              class="text-[12px] font-bold uppercase tracking-tighter text-ui-text-muted/80"
            >
              Cursor
            </h3>
            <p class="text-[12px] text-ui-text-muted leading-relaxed">
              连接当前 Cursor 页面。
            </p>
            <p class="text-[11px] text-ui-text-muted/80">
              {{
                findCursorWebProfile()
                  ? "已连接当前 Cursor 页面"
                  : "未连接 Cursor"
              }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
            :disabled="Boolean(bindingLoading[CURSOR_WEB_PROFILE_ID])"
            @click="enableCursorWebPreset"
          >
            <Loader2
              v-if="bindingLoading[CURSOR_WEB_PROFILE_ID]"
              class="animate-spin"
              :size="12"
              aria-hidden="true"
            />
            <span>{{
              findCursorWebProfile() ? "重新连接" : "连接 Cursor"
            }}</span>
          </button>
        </div>
      </section>

      <section
        class="border border-ui-border bg-ui-surface/30 p-3 rounded-sm space-y-3"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="space-y-1">
            <h3
              class="text-[12px] font-bold uppercase tracking-tighter text-ui-text-muted/80"
            >
              已保存的模型
            </h3>
            <p class="text-[12px] text-ui-text-muted">管理可用模型。</p>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            aria-label="新增模型"
            @click="addProfile"
          >
            <Plus :size="14" aria-hidden="true" />
            新增模型
          </button>
        </div>

        <article
          v-for="(profile, index) in config.llmProfiles"
          :key="profile.id || `${index}`"
          class="border border-ui-border rounded-sm p-3 space-y-3 bg-ui-bg"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="space-y-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <h4 class="text-[13px] font-semibold text-ui-text">
                  {{ getProfileTitle(profile, index) }}
                </h4>
                <span
                  v-if="isDefaultProfile(profile)"
                  class="inline-flex items-center rounded-full border border-ui-accent/30 bg-ui-accent/10 px-2 py-0.5 text-[10px] font-semibold text-ui-accent"
                >
                  默认
                </span>
                <span
                  v-if="isAuxProfile(profile)"
                  class="inline-flex items-center rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10px] font-semibold text-sky-500"
                >
                  标题/摘要
                </span>
                <span
                  v-if="isFallbackProfile(profile)"
                  class="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600"
                >
                  备用
                </span>
                <span
                  class="inline-flex items-center rounded-full border border-ui-border bg-ui-surface px-2 py-0.5 text-[10px] text-ui-text-muted"
                >
                  {{ getProviderLabel(profile) }}
                </span>
              </div>
              <p class="text-[11px] text-ui-text-muted leading-relaxed">
                {{ getProfileSummary(profile) }}
              </p>
            </div>
            <button
              type="button"
              class="p-1.5 rounded-sm border border-ui-border hover:bg-ui-surface disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :disabled="config.llmProfiles.length <= 1"
              :aria-label="`删除模型 ${getProfileTitle(profile, index)}`"
              @click="removeProfile(profile.id)"
            >
              <Trash2 :size="14" aria-hidden="true" />
            </button>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label class="space-y-1 block">
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >模型标识</span
              >
              <input
                v-model="profile.id"
                type="text"
                :readonly="isCursorHelpWebProvider(profile)"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="fast-main"
              />
            </label>

            <label class="space-y-1 block">
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >接入方式</span
              >
              <select
                v-model="profile.provider"
                :disabled="isCursorHelpWebProvider(profile)"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                @change="void handleProviderChange(profile)"
              >
                <option
                  v-for="option in getProviderSelectOptions(profile)"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>

            <template v-if="isCursorHelpWebProvider(profile)">
              <label class="space-y-1 block sm:col-span-2">
                <span
                  class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                  >连接页面</span
                >
                <div class="flex items-center gap-2">
                  <div
                    class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] text-ui-text-muted"
                  >
                    {{
                      getCursorHelpTargetTabId(profile)
                        ? `已连接 Cursor 页面 #${getCursorHelpTargetTabId(profile)}`
                        : "保存时会自动连接 Cursor"
                    }}
                  </div>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                    :disabled="bindingLoading[profile.id]"
                    @click="bindCurrentTab(profile)"
                  >
                    <Loader2
                      v-if="bindingLoading[profile.id]"
                      class="animate-spin"
                      :size="12"
                      aria-hidden="true"
                    />
                    <span>重新连接页面</span>
                  </button>
                </div>
              </label>

              <label class="space-y-1 block sm:col-span-2">
                <span
                  class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                  >页面中的模型</span
                >
                <div class="flex items-center gap-2">
                  <div
                    class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] text-ui-text-muted"
                  >
                    {{
                      getCursorHelpDetectedModel(profile)
                        ? `当前检测到：${getCursorHelpDetectedModel(profile)}`
                        : "暂未识别，默认跟随 Cursor 页面当前模型"
                    }}
                  </div>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                    :disabled="bindingLoading[profile.id]"
                    @click="bindCurrentTab(profile)"
                  >
                    <Loader2
                      v-if="bindingLoading[profile.id]"
                      class="animate-spin"
                      :size="12"
                      aria-hidden="true"
                    />
                    <span>刷新页面状态</span>
                  </button>
                </div>
              </label>

              <label
                v-if="getCursorHelpModelOptions(profile).length > 1"
                class="space-y-1 block sm:col-span-2"
              >
                <span
                  class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                  >发送时使用</span
                >
                <select
                  v-model="profile.llmModel"
                  class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                >
                  <option value="auto">跟随页面当前模型</option>
                  <option
                    v-for="model in getCursorHelpModelOptions(profile).filter(
                      (item) => item !== 'auto',
                    )"
                    :key="model"
                    :value="model"
                  >
                    {{ model }}
                  </option>
                </select>
              </label>

              <label v-else class="space-y-1 block sm:col-span-2">
                <span
                  class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                  >发送时使用</span
                >
                <input
                  v-model="profile.llmModel"
                  type="text"
                  class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  placeholder="auto 或具体模型名"
                />
              </label>
            </template>

            <label
              v-if="!isCursorHelpWebProvider(profile)"
              class="space-y-1 block sm:col-span-2"
            >
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >接口地址</span
              >
              <input
                v-model="profile.llmApiBase"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="https://api.example.com/v1"
              />
            </label>

            <label
              v-if="!isCursorHelpWebProvider(profile)"
              class="space-y-1 block sm:col-span-2"
            >
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >访问密钥</span
              >
              <div class="relative">
                <input
                  v-model="profile.llmApiKey"
                  :type="showApiKeys[profile.id] ? 'text' : 'password'"
                  autocomplete="off"
                  class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 pr-10 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                />
                <button
                  type="button"
                  class="absolute inset-y-0 right-0 px-2 text-ui-text-muted hover:text-ui-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  :aria-label="
                    showApiKeys[profile.id] ? '隐藏 API Key' : '显示 API Key'
                  "
                  :aria-pressed="Boolean(showApiKeys[profile.id])"
                  @click="toggleApiKey(profile.id)"
                >
                  <EyeOff
                    v-if="showApiKeys[profile.id]"
                    :size="14"
                    aria-hidden="true"
                  />
                  <Eye v-else :size="14" aria-hidden="true" />
                </button>
              </div>
            </label>

            <label
              v-if="!isCursorHelpWebProvider(profile)"
              class="space-y-1 block sm:col-span-2"
            >
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >模型</span
              >
              <input
                v-model="profile.llmModel"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="gpt-5.3-codex"
              />
            </label>

            <details
              v-if="!isCursorHelpWebProvider(profile)"
              class="sm:col-span-2 rounded-sm border border-ui-border bg-ui-surface/40 px-3 py-2 group"
            >
              <summary
                class="cursor-pointer list-none flex items-center justify-between gap-2"
              >
                <span
                  class="text-[11px] font-bold uppercase tracking-tighter text-ui-text-muted/80"
                  >高级设置</span
                >
                <span class="text-[11px] text-ui-text-muted group-open:hidden"
                  >展开</span
                >
                <span
                  class="text-[11px] text-ui-text-muted hidden group-open:inline"
                  >收起</span
                >
              </summary>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 pt-3">
                <label class="space-y-1 block">
                  <span
                    class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                    >请求超时 (ms)</span
                  >
                  <input
                    v-model.number="profile.llmTimeoutMs"
                    type="number"
                    min="1000"
                    step="1000"
                    class="w-full bg-ui-bg border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  />
                </label>

                <label class="space-y-1 block">
                  <span
                    class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                    >失败重试次数</span
                  >
                  <input
                    v-model.number="profile.llmRetryMaxAttempts"
                    type="number"
                    min="0"
                    max="6"
                    class="w-full bg-ui-bg border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  />
                </label>

                <label class="space-y-1 block sm:col-span-2">
                  <span
                    class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                    >最大重试等待 (ms)</span
                  >
                  <input
                    v-model.number="profile.llmMaxRetryDelayMs"
                    type="number"
                    min="0"
                    step="1000"
                    class="w-full bg-ui-bg border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  />
                </label>
              </div>
            </details>
          </div>
        </article>
      </section>
    </main>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="visibleError" class="text-[11px] text-red-500 mb-3 px-1">
        {{ visibleError }}
      </p>
      <button
        class="w-full bg-ui-text text-ui-bg py-2.5 rounded-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :disabled="savingConfig"
        @click="handleSave"
      >
        <Loader2 v-if="savingConfig" class="animate-spin" :size="16" />
        {{ savingConfig ? "保存中..." : "保存并生效" }}
      </button>
    </footer>
  </div>
</template>
