<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import {
  DEFAULT_PANEL_LLM_API_BASE,
  DEFAULT_PANEL_LLM_MODEL,
  DEFAULT_PANEL_LLM_PROVIDER,
  useRuntimeStore,
  type PanelLlmProfile
} from "../stores/runtime";
import { ArrowLeft, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();
const { config, savingConfig, error } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const localError = ref("");
const chainsText = ref("{}");
const showApiKeys = ref<Record<string, boolean>>({});
const bindingLoading = ref<Record<string, boolean>>({});

const defaultProfileId = "provider-default-profile";
const escalationPolicyId = "provider-escalation-policy";
const profileChainsId = "provider-profile-chains";
const CURSOR_WEB_PROFILE_ID = "cursor-web";
const CURSOR_HELP_URL = "https://cursor.com/help";
const CURSOR_TAB_PATTERNS = ["https://cursor.com/help*", "https://cursor.com/*"] as const;
const builtinProviderOptions = [
  { value: "openai_compatible", label: "通用 API" },
  { value: "cursor_help_web", label: "Cursor 网页聊天" }
] as const;

const visibleError = computed(() => localError.value || String(error.value || ""));

function normalizeProfileId(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function providerOptions(profile: PanelLlmProfile): Record<string, unknown> {
  if (!profile.providerOptions || typeof profile.providerOptions !== "object") {
    profile.providerOptions = {};
  }
  return profile.providerOptions;
}

function isCursorHelpWebProvider(profile: PanelLlmProfile): boolean {
  return String(profile.provider || "").trim().toLowerCase() === "cursor_help_web";
}

function findCursorWebProfile(): PanelLlmProfile | null {
  return config.value.llmProfiles.find((profile) => isCursorHelpWebProvider(profile)) || null;
}

function getProviderSelectOptions(profile: PanelLlmProfile): Array<{ value: string; label: string }> {
  const current = String(profile.provider || "").trim();
  if (!current) return [...builtinProviderOptions];
  if (builtinProviderOptions.some((item) => item.value === current)) {
    return [...builtinProviderOptions];
  }
  return [{ value: current, label: `自定义接入 (${current})` }, ...builtinProviderOptions];
}

function isDefaultProfile(profile: PanelLlmProfile): boolean {
  return String(profile.id || "").trim() === String(config.value.llmDefaultProfile || "").trim();
}

function getProviderLabel(profile: PanelLlmProfile): string {
  const provider = String(profile.provider || "").trim().toLowerCase();
  if (provider === "cursor_help_web") return "Cursor 网页聊天";
  if (provider === "openai_compatible") return "通用 API";
  return String(profile.provider || "").trim() || "未命名接入";
}

function getProfileTitle(profile: PanelLlmProfile, index: number): string {
  return String(profile.id || "").trim() || `模型方案 ${index + 1}`;
}

function getProfileSummary(profile: PanelLlmProfile): string {
  if (isCursorHelpWebProvider(profile)) {
    return getCursorHelpTargetTabId(profile)
      ? "已连接到 Cursor Help，会优先沿用网页中的当前模型。"
      : "保存后会自动连接 Cursor Help。";
  }
  const role = String(profile.role || "").trim() || "worker";
  const model = String(profile.llmModel || "").trim() || "未设置模型";
  const base = String(profile.llmApiBase || "").trim() || "未设置接口地址";
  return `${role} 任务默认走 ${model} · ${base}`;
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

function setCursorHelpTargetTabId(profile: PanelLlmProfile, value: unknown): void {
  const options = providerOptions(profile);
  const raw = Number(value);
  if (Number.isInteger(raw) && raw > 0) {
    options.targetTabId = raw;
  } else {
    delete options.targetTabId;
  }
  options.targetSite = "cursor_help";
}

async function sendTabMessageWithRetry(tabId: number, message: Record<string, unknown>, retries = 12): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "标签页通信失败"));
}

async function inspectCursorTab(tabId: number): Promise<{ isReady: boolean; url: string } | null> {
  const response = await sendTabMessageWithRetry(tabId, {
    type: "webchat.inspect"
  }).catch(() => null);
  const row = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
  if (!row || row.ok !== true) return null;
  return {
    isReady: row.isReady === true,
    url: String(row.url || "")
  };
}

async function locateCursorChatTab(active: boolean): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: [...CURSOR_TAB_PATTERNS] });
  const sorted = [...tabs].sort((left, right) => {
    const leftHelp = String(left.url || "").startsWith(CURSOR_HELP_URL) ? 1 : 0;
    const rightHelp = String(right.url || "").startsWith(CURSOR_HELP_URL) ? 1 : 0;
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
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
          // noop
        });
      }
    }
    return tab;
  }
  return null;
}

async function openCursorFallbackTab(active: boolean): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({
    url: CURSOR_HELP_URL,
    active
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

async function ensureCursorHelpTab(profile: PanelLlmProfile, active: boolean): Promise<void> {
  const profileId = String(profile.id || "").trim();
  if (!profileId) return;
  bindingLoading.value = {
    ...bindingLoading.value,
    [profileId]: true
  };
  localError.value = "";
  try {
    let boundTab = await locateCursorChatTab(active);

    if (!boundTab?.id) {
      boundTab = await openCursorFallbackTab(active);
    }

    if (!boundTab?.id) {
      throw new Error("未能打开 Cursor Help 页面");
    }
    await focusTab(boundTab);
    setCursorHelpTargetTabId(profile, boundTab.id);
    await inspectCursorHelpTab(profile, boundTab.id);
    const inspected = await inspectCursorTab(boundTab.id);
    if (!inspected?.isReady) {
      localError.value = "已打开 Cursor Help 页面，但内置 provider 尚未就绪。请确认页面已完成加载后再试。";
    }
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  } finally {
    bindingLoading.value = {
      ...bindingLoading.value,
      [profileId]: false
    };
  }
}

async function inspectCursorHelpTab(profile: PanelLlmProfile, tabId = Number(getCursorHelpTargetTabId(profile))): Promise<void> {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const response = await sendTabMessageWithRetry(tabId, {
    type: "webchat.inspect"
  }).catch(() => null);
  const row = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const options = providerOptions(profile);
  const selectedModel = String(row.selectedModel || "").trim();
  const availableModels = Array.isArray(row.availableModels)
    ? row.availableModels.map((item) => String(item || "").trim()).filter(Boolean)
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
  if (!String(profile.llmModel || "").trim() || String(profile.llmModel || "").trim() === DEFAULT_PANEL_LLM_MODEL) {
    profile.llmModel = "auto";
  }
  await ensureCursorHelpTab(profile, true);
}

async function enableCursorWebPreset(): Promise<void> {
  localError.value = "";
  ensureProfiles();
  let profile = findCursorWebProfile();
  if (!profile) {
    profile = {
      id: CURSOR_WEB_PROFILE_ID,
      provider: "cursor_help_web",
      llmApiBase: "",
      llmApiKey: "",
      llmModel: "auto",
      providerOptions: {
        targetSite: "cursor_help"
      },
      role: "worker",
      llmTimeoutMs: 120000,
      llmRetryMaxAttempts: 1,
      llmMaxRetryDelayMs: 60000
    };
    config.value.llmProfiles.unshift(profile);
  }
  profile.provider = "cursor_help_web";
  profile.role = "worker";
  profile.llmApiBase = "";
  profile.llmApiKey = "";
  profile.llmModel = String(profile.llmModel || "auto").trim() || "auto";
  providerOptions(profile).targetSite = "cursor_help";
  config.value.llmDefaultProfile = profile.id;
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
    role: "worker",
    llmTimeoutMs: Number(config.value.llmTimeoutMs || 120000),
    llmRetryMaxAttempts: Number(config.value.llmRetryMaxAttempts || 2),
    llmMaxRetryDelayMs: Number(config.value.llmMaxRetryDelayMs || 60000)
  };
}

function nextProfileId(): string {
  const existing = new Set(config.value.llmProfiles.map((item) => String(item.id || "").trim()));
  let index = config.value.llmProfiles.length + 1;
  while (existing.has(`profile-${index}`)) {
    index += 1;
  }
  return `profile-${index}`;
}

function ensureProfiles(): void {
  if (!Array.isArray(config.value.llmProfiles) || config.value.llmProfiles.length === 0) {
    config.value.llmProfiles = [buildDefaultProfile("default")];
  }
  const firstId = String(config.value.llmProfiles[0]?.id || "").trim();
  const hasDefault = config.value.llmProfiles.some((item) => String(item.id || "").trim() === config.value.llmDefaultProfile);
  if (!hasDefault) {
    config.value.llmDefaultProfile = firstId || "default";
  }
}

function toggleApiKey(profileId: string): void {
  const id = String(profileId || "").trim();
  if (!id) return;
  showApiKeys.value = {
    ...showApiKeys.value,
    [id]: !showApiKeys.value[id]
  };
}

function addProfile(): void {
  localError.value = "";
  ensureProfiles();
  config.value.llmProfiles.push(buildDefaultProfile(nextProfileId()));
}

function removeProfile(profileId: string): void {
  if (config.value.llmProfiles.length <= 1) {
    localError.value = "至少保留一个 LLM Profile";
    return;
  }
  const id = String(profileId || "").trim();
  config.value.llmProfiles = config.value.llmProfiles.filter((item) => String(item.id || "").trim() !== id);
  ensureProfiles();
}

function formatChains(value: unknown): string {
  const source = value && typeof value === "object" ? value : {};
  try {
    return JSON.stringify(source, null, 2);
  } catch {
    return "{}";
  }
}

function parseProfileChains(text: string, validIds: Set<string>): Record<string, string[]> {
  if (!String(text || "").trim()) return {};
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(String(text || "{}"));
  } catch {
    throw new Error("Profile Chains 必须是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Profile Chains 必须是 role -> profileId[] 的对象");
  }
  const out: Record<string, string[]> = {};
  for (const [roleRaw, listRaw] of Object.entries(parsed as Record<string, unknown>)) {
    const role = String(roleRaw || "").trim();
    if (!role || !Array.isArray(listRaw)) continue;
    const dedup = new Set<string>();
    const ids: string[] = [];
    for (const item of listRaw) {
      const id = String(item || "").trim();
      if (!id || dedup.has(id) || !validIds.has(id)) continue;
      dedup.add(id);
      ids.push(id);
    }
    if (ids.length > 0) out[role] = ids;
  }
  return out;
}

function normalizeProfilesBeforeSave(): void {
  const dedup = new Set<string>();
  const normalized: PanelLlmProfile[] = [];

  for (const raw of config.value.llmProfiles) {
    const normalizedId = normalizeProfileId(String(raw.id || "")) || nextProfileId();
    if (dedup.has(normalizedId)) continue;
    dedup.add(normalizedId);
    const provider = String(raw.provider || DEFAULT_PANEL_LLM_PROVIDER).trim() || DEFAULT_PANEL_LLM_PROVIDER;
    const providerOptions = raw.providerOptions && typeof raw.providerOptions === "object" ? { ...raw.providerOptions } : {};
    if (provider.toLowerCase() === "cursor_help_web") {
      providerOptions.targetSite = "cursor_help";
    }
    normalized.push({
      id: normalizedId,
      provider,
      llmApiBase: String(raw.llmApiBase || "").trim(),
      llmApiKey: String(raw.llmApiKey || ""),
      llmModel: String(raw.llmModel || DEFAULT_PANEL_LLM_MODEL).trim() || DEFAULT_PANEL_LLM_MODEL,
      providerOptions,
      role: String(raw.role || "worker").trim() || "worker",
      llmTimeoutMs: Math.max(1000, Number(raw.llmTimeoutMs || 120000)),
      llmRetryMaxAttempts: Math.max(0, Math.min(6, Number(raw.llmRetryMaxAttempts || 2))),
      llmMaxRetryDelayMs: Math.max(0, Number(raw.llmMaxRetryDelayMs || 60000))
    });
  }

  config.value.llmProfiles = normalized.length > 0 ? normalized : [buildDefaultProfile("default")];
  ensureProfiles();
}

async function handleSave(): Promise<void> {
  localError.value = "";
  try {
    normalizeProfilesBeforeSave();
    for (const profile of config.value.llmProfiles) {
      if (isCursorHelpWebProvider(profile) && !getCursorHelpTargetTabId(profile)) {
        await ensureCursorHelpTab(profile, false);
      }
    }
    const validIds = new Set(config.value.llmProfiles.map((item) => item.id));
    config.value.llmProfileChains = parseProfileChains(chainsText.value, validIds);
    config.value.llmEscalationPolicy = config.value.llmEscalationPolicy === "disabled" ? "disabled" : "upgrade_only";
    await store.saveConfig();
    emit("close");
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  ensureProfiles();
  chainsText.value = formatChains(config.value.llmProfileChains);
  dialogRef.value?.focus();
});
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="模型与 Provider"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="返回"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" aria-hidden="true" />
      </button>
      <h2 class="ml-2 text-[13px] font-bold tracking-tight">模型与 Provider</h2>
    </header>

    <main class="flex-1 overflow-y-auto p-4 space-y-4">
      <section class="border border-ui-border bg-ui-surface/30 p-3 rounded-sm space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-1">
            <h3 class="text-[12px] font-bold uppercase tracking-tighter text-ui-text-muted/80">Cursor 网页聊天</h3>
            <p class="text-[12px] text-ui-text-muted leading-relaxed">
              一键启用内置的 Cursor Help provider。保存后会自动打开并绑定 `https://cursor.com/help`，请求直接走页面内的 `/api/chat`。
            </p>
            <p class="text-[11px] text-ui-text-muted/80">
              {{
                findCursorWebProfile()
                  ? `当前已启用：${findCursorWebProfile()?.id}（${String(findCursorWebProfile()?.llmModel || "").trim() || "auto"}）`
                  : "当前未启用"
              }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
            :disabled="Boolean(bindingLoading[CURSOR_WEB_PROFILE_ID])"
            @click="enableCursorWebPreset"
          >
            <Loader2 v-if="bindingLoading[CURSOR_WEB_PROFILE_ID]" class="animate-spin" :size="12" aria-hidden="true" />
            <span>{{ findCursorWebProfile() ? "重新连接" : "一键启用" }}</span>
          </button>
        </div>
      </section>

      <section class="border border-ui-border bg-ui-surface/30 p-3 rounded-sm space-y-3">
        <p class="text-[12px] text-ui-text-muted leading-relaxed">
          配置多个 LLM Profile（可指向不同 Provider/Base URL/Model），并设置默认 profile 与升级策略。
        </p>
        <div class="grid grid-cols-1 gap-3">
          <div class="space-y-1.5">
            <label :for="defaultProfileId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">默认 Profile</label>
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
                {{ profile.id }} ({{ profile.provider }})
              </option>
            </select>
          </div>

          <div class="space-y-1.5">
            <label :for="escalationPolicyId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">升级策略</label>
            <select
              :id="escalationPolicyId"
              v-model="config.llmEscalationPolicy"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <option value="upgrade_only">upgrade_only（失败后升级 profile）</option>
              <option value="disabled">disabled（禁用升级）</option>
            </select>
          </div>

          <div class="space-y-1.5">
            <label :for="profileChainsId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">
              Role Chains (JSON，可选)
            </label>
            <textarea
              :id="profileChainsId"
              v-model="chainsText"
              rows="4"
              spellcheck="false"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[12px] font-mono leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              placeholder='{"worker":["default","worker-pro"],"reviewer":["reviewer-basic"]}'
            />
          </div>
        </div>
      </section>

      <section class="border border-ui-border bg-ui-surface/30 p-3 rounded-sm space-y-3">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-[12px] font-bold uppercase tracking-tighter text-ui-text-muted/80">Profiles</h3>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            aria-label="新增 Profile"
            @click="addProfile"
          >
            <Plus :size="14" aria-hidden="true" />
            新增
          </button>
        </div>

        <article
          v-for="(profile, index) in config.llmProfiles"
          :key="profile.id || `${index}`"
          class="border border-ui-border rounded-sm p-3 space-y-2.5 bg-ui-bg"
        >
          <div class="flex items-center justify-between gap-2">
            <h4 class="text-[12px] font-semibold">Profile #{{ index + 1 }}</h4>
            <button
              type="button"
              class="p-1.5 rounded-sm border border-ui-border hover:bg-ui-surface disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :disabled="config.llmProfiles.length <= 1"
              :aria-label="`删除 profile ${profile.id || index + 1}`"
              @click="removeProfile(profile.id)"
            >
              <Trash2 :size="14" aria-hidden="true" />
            </button>
          </div>

          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label class="space-y-1 block">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">ID</span>
              <input
                v-model="profile.id"
                type="text"
                :readonly="isCursorHelpWebProvider(profile)"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="worker.basic"
              />
            </label>

            <label class="space-y-1 block">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Provider</span>
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
                <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">绑定页面</span>
                <div class="flex items-center gap-2">
                  <div class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] text-ui-text-muted">
                    {{
                      getCursorHelpTargetTabId(profile)
                        ? `已绑定 Cursor Help 页面 #${getCursorHelpTargetTabId(profile)}`
                        : "保存时会自动打开并绑定 Cursor Help 页面"
                    }}
                  </div>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                    :disabled="bindingLoading[profile.id]"
                    @click="bindCurrentTab(profile)"
                  >
                    <Loader2 v-if="bindingLoading[profile.id]" class="animate-spin" :size="12" aria-hidden="true" />
                    <span>打开 Help 并重连</span>
                  </button>
                </div>
              </label>
            </template>

            <label class="space-y-1 block" v-if="!isCursorHelpWebProvider(profile)">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Role</span>
              <input
                v-model="profile.role"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="worker"
              />
            </label>

            <template v-if="isCursorHelpWebProvider(profile)">
              <label class="space-y-1 block sm:col-span-2">
                <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">当前页面模型</span>
                <div class="flex items-center gap-2">
                  <div class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] text-ui-text-muted">
                    {{
                      getCursorHelpDetectedModel(profile)
                        ? `页面当前模型：${getCursorHelpDetectedModel(profile)}`
                        : "暂未识别，默认跟随 Cursor 页面当前模型"
                    }}
                  </div>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                    :disabled="bindingLoading[profile.id]"
                    @click="bindCurrentTab(profile)"
                  >
                    <Loader2 v-if="bindingLoading[profile.id]" class="animate-spin" :size="12" aria-hidden="true" />
                    <span>刷新页面状态</span>
                  </button>
                </div>
              </label>

              <label v-if="getCursorHelpModelOptions(profile).length > 1" class="space-y-1 block sm:col-span-2">
                <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">请求模型</span>
                <select
                  v-model="profile.llmModel"
                  class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                >
                  <option value="auto">auto（跟随当前页面模型）</option>
                  <option
                    v-for="model in getCursorHelpModelOptions(profile).filter((item) => item !== 'auto')"
                    :key="model"
                    :value="model"
                  >
                    {{ model }}
                  </option>
                </select>
              </label>

              <label v-else class="space-y-1 block sm:col-span-2">
                <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Model</span>
                <input
                  v-model="profile.llmModel"
                  type="text"
                  class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  placeholder="auto 或 anthropic/claude-sonnet-4.6"
                />
              </label>
            </template>

            <label v-if="!isCursorHelpWebProvider(profile)" class="space-y-1 block sm:col-span-2">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Base URL</span>
              <input
                v-model="profile.llmApiBase"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="https://api.example.com/v1"
              />
            </label>

            <label v-if="!isCursorHelpWebProvider(profile)" class="space-y-1 block sm:col-span-2">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">API Key</span>
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
                  :aria-label="showApiKeys[profile.id] ? '隐藏 API Key' : '显示 API Key'"
                  :aria-pressed="Boolean(showApiKeys[profile.id])"
                  @click="toggleApiKey(profile.id)"
                >
                  <EyeOff v-if="showApiKeys[profile.id]" :size="14" aria-hidden="true" />
                  <Eye v-else :size="14" aria-hidden="true" />
                </button>
              </div>
            </label>

            <label v-if="!isCursorHelpWebProvider(profile)" class="space-y-1 block sm:col-span-2">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Model</span>
              <input
                v-model="profile.llmModel"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="gpt-5.3-codex"
              />
            </label>

            <label v-if="!isCursorHelpWebProvider(profile)" class="space-y-1 block">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Timeout (ms)</span>
              <input
                v-model.number="profile.llmTimeoutMs"
                type="number"
                min="1000"
                step="1000"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </label>

            <label v-if="!isCursorHelpWebProvider(profile)" class="space-y-1 block">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Retry Attempts</span>
              <input
                v-model.number="profile.llmRetryMaxAttempts"
                type="number"
                min="0"
                max="6"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </label>

            <label v-if="!isCursorHelpWebProvider(profile)" class="space-y-1 block sm:col-span-2">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Max Retry Delay (ms)</span>
              <input
                v-model.number="profile.llmMaxRetryDelayMs"
                type="number"
                min="0"
                step="1000"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </label>
          </div>
        </article>
      </section>
    </main>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="visibleError" class="text-[11px] text-red-500 mb-3 px-1">{{ visibleError }}</p>
      <button
        class="w-full bg-ui-text text-ui-bg py-2.5 rounded-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :disabled="savingConfig"
        @click="handleSave"
      >
        <Loader2 v-if="savingConfig" class="animate-spin" :size="16" />
        {{ savingConfig ? '保存中...' : '保存模型配置' }}
      </button>
    </footer>
  </div>
</template>
