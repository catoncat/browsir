<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import { useRuntimeStore, type PanelLlmProfile } from "../stores/runtime";
import { ArrowLeft, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();
const { config, savingConfig, error } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const localError = ref("");
const chainsText = ref("{}");
const showApiKeys = ref<Record<string, boolean>>({});

const defaultProfileId = "provider-default-profile";
const escalationPolicyId = "provider-escalation-policy";
const profileChainsId = "provider-profile-chains";

const visibleError = computed(() => localError.value || String(error.value || ""));

function normalizeProfileId(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildDefaultProfile(idSeed: string): PanelLlmProfile {
  const id = normalizeProfileId(idSeed) || "profile-default";
  return {
    id,
    provider: "openai_compatible",
    llmApiBase: String(config.value.llmApiBase || "").trim(),
    llmApiKey: String(config.value.llmApiKey || ""),
    llmModel: String(config.value.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex",
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
    normalized.push({
      id: normalizedId,
      provider: String(raw.provider || "openai_compatible").trim() || "openai_compatible",
      llmApiBase: String(raw.llmApiBase || "").trim(),
      llmApiKey: String(raw.llmApiKey || ""),
      llmModel: String(raw.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex",
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
    aria-label="LLM Provider 设置"
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
      <h2 class="ml-2 text-[13px] font-bold tracking-tight">LLM Provider 设置</h2>
    </header>

    <main class="flex-1 overflow-y-auto p-4 space-y-4">
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
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="worker.basic"
              />
            </label>

            <label class="space-y-1 block">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Provider</span>
              <input
                v-model="profile.provider"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="openai_compatible"
              />
            </label>

            <label class="space-y-1 block">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Role</span>
              <input
                v-model="profile.role"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="worker"
              />
            </label>

            <label class="space-y-1 block sm:col-span-2">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Base URL</span>
              <input
                v-model="profile.llmApiBase"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="https://api.example.com/v1"
              />
            </label>

            <label class="space-y-1 block sm:col-span-2">
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

            <label class="space-y-1 block sm:col-span-2">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Model</span>
              <input
                v-model="profile.llmModel"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="gpt-5.3-codex"
              />
            </label>

            <label class="space-y-1 block">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Timeout (ms)</span>
              <input
                v-model.number="profile.llmTimeoutMs"
                type="number"
                min="1000"
                step="1000"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </label>

            <label class="space-y-1 block">
              <span class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Retry Attempts</span>
              <input
                v-model.number="profile.llmRetryMaxAttempts"
                type="number"
                min="0"
                max="6"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </label>

            <label class="space-y-1 block sm:col-span-2">
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
        {{ savingConfig ? 'Saving...' : 'Apply Provider Config' }}
      </button>
    </footer>
  </div>
</template>
