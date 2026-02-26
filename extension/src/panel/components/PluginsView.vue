<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRuntimeStore, type PluginMetadata } from "../stores/runtime";
import { ArrowLeft, Loader2, RefreshCcw, Power, Trash2, Plus } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();

const dialogRef = ref<HTMLElement | null>(null);
const loading = ref(false);
const registering = ref(false);
const actionPluginId = ref("");
const pageError = ref("");
const plugins = ref<PluginMetadata[]>([]);
const llmProviders = ref<Array<Record<string, unknown>>>([]);

const replaceOnRegister = ref(true);
const enableOnRegister = ref(true);
const pluginJson = ref(`{
  "manifest": {
    "id": "plugin.proxy.demo",
    "name": "proxy-demo",
    "version": "1.0.0",
    "permissions": {
      "llmProviders": ["proxy.demo"]
    }
  },
  "llmProviders": [
    {
      "id": "proxy.demo",
      "transport": "openai_compatible",
      "baseUrl": "https://proxy.example.com/v1"
    }
  ]
}`);

function setPageError(error: unknown) {
  pageError.value = error instanceof Error ? error.message : String(error || "未知错误");
}

function formatList(values: string[]): string {
  if (!values.length) return "无";
  return values.join(", ");
}

function providerSummary(row: Record<string, unknown>): string {
  const id = String(row.id || "").trim() || "unknown";
  const transport = String(row.transport || "custom").trim();
  return `${id} (${transport})`;
}

function parsePluginJsonDraft(): Record<string, unknown> {
  const text = String(pluginJson.value || "").trim();
  if (!text) {
    throw new Error("插件 JSON 不能为空");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`插件 JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("插件 JSON 必须是 object");
  }
  return parsed as Record<string, unknown>;
}

async function refreshPlugins() {
  loading.value = true;
  pageError.value = "";
  try {
    const out = await store.listPlugins();
    plugins.value = out.plugins;
    llmProviders.value = out.llmProviders;
  } catch (error) {
    setPageError(error);
  } finally {
    loading.value = false;
  }
}

async function handleRegister() {
  registering.value = true;
  pageError.value = "";
  try {
    const plugin = parsePluginJsonDraft();
    await store.registerPlugin(plugin, {
      replace: replaceOnRegister.value,
      enable: enableOnRegister.value
    });
    await refreshPlugins();
  } catch (error) {
    setPageError(error);
  } finally {
    registering.value = false;
  }
}

async function handleToggle(plugin: PluginMetadata) {
  const pluginId = String(plugin.id || "").trim();
  if (!pluginId) return;
  actionPluginId.value = pluginId;
  pageError.value = "";
  try {
    if (plugin.enabled) {
      await store.disablePlugin(pluginId);
    } else {
      await store.enablePlugin(pluginId);
    }
    await refreshPlugins();
  } catch (error) {
    setPageError(error);
  } finally {
    actionPluginId.value = "";
  }
}

async function handleUnregister(plugin: PluginMetadata) {
  const pluginId = String(plugin.id || "").trim();
  if (!pluginId) return;
  const confirmed = globalThis.confirm(`确认卸载插件 ${plugin.name || plugin.id} ?`);
  if (!confirmed) return;
  actionPluginId.value = pluginId;
  pageError.value = "";
  try {
    await store.unregisterPlugin(pluginId);
    await refreshPlugins();
  } catch (error) {
    setPageError(error);
  } finally {
    actionPluginId.value = "";
  }
}

onMounted(async () => {
  dialogRef.value?.focus();
  await refreshPlugins();
});
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="插件管理"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="关闭插件管理"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" />
      </button>
      <h2 class="ml-2 font-bold text-[14px] text-ui-text tracking-tight">插件管理</h2>
      <button
        class="ml-auto p-2 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
        :disabled="loading"
        aria-label="刷新插件列表"
        @click="refreshPlugins"
      >
        <RefreshCcw :size="16" :class="loading ? 'animate-spin' : ''" />
      </button>
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-6">
      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">快速注册（JSON）</h3>
        <p class="text-[11px] text-ui-text-muted">
          这里走 `brain.plugin.register`。JSON 方式适合声明式配置（比如 llmProviders）。
        </p>
        <textarea
          v-model="pluginJson"
          rows="12"
          class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[12px] font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent resize-y"
          aria-label="插件 JSON"
        />
        <div class="flex flex-wrap items-center gap-3">
          <label class="inline-flex items-center gap-2 text-[12px] text-ui-text-muted">
            <input v-model="replaceOnRegister" type="checkbox" class="h-3.5 w-3.5" />
            replace
          </label>
          <label class="inline-flex items-center gap-2 text-[12px] text-ui-text-muted">
            <input v-model="enableOnRegister" type="checkbox" class="h-3.5 w-3.5" />
            enable
          </label>
          <button
            class="ml-auto px-3 py-2 rounded-sm bg-ui-surface border border-ui-border text-[12px] font-semibold hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
            :disabled="registering"
            @click="handleRegister"
          >
            <Loader2 v-if="registering" :size="14" class="inline-block animate-spin mr-1" />
            <Plus v-else :size="14" class="inline-block mr-1" />
            注册插件
          </button>
        </div>
      </section>

      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">已注册插件</h3>
        <div v-if="plugins.length === 0" class="rounded-md border border-ui-border bg-ui-surface/20 px-3 py-2 text-[12px] text-ui-text-muted">
          暂无插件
        </div>
        <ul v-else class="space-y-2">
          <li v-for="plugin in plugins" :key="plugin.id" class="rounded-md border border-ui-border bg-ui-surface/20 px-3 py-2 space-y-2">
            <div class="flex items-center gap-2">
              <div class="min-w-0">
                <p class="text-[13px] font-semibold text-ui-text truncate">{{ plugin.name || plugin.id }}</p>
                <p class="text-[11px] text-ui-text-muted">{{ plugin.id }} · v{{ plugin.version }}</p>
              </div>
              <span
                class="ml-auto rounded px-2 py-0.5 text-[10px] font-semibold"
                :class="plugin.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-ui-border/40 text-ui-text-muted'"
              >
                {{ plugin.enabled ? "enabled" : "disabled" }}
              </span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-ui-text-muted">
              <p>hooks: {{ formatList(plugin.hooks) }}</p>
              <p>modes: {{ formatList(plugin.modes) }}</p>
              <p>capabilities: {{ formatList(plugin.capabilities) }}</p>
              <p>llmProviders: {{ formatList(plugin.llmProviders) }}</p>
            </div>
            <p v-if="plugin.lastError" class="text-[11px] text-rose-600">lastError: {{ plugin.lastError }}</p>
            <div class="flex items-center gap-2">
              <button
                class="px-2.5 py-1.5 rounded-sm bg-ui-bg border border-ui-border text-[12px] hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                :disabled="actionPluginId === plugin.id"
                @click="handleToggle(plugin)"
              >
                <Power :size="13" class="inline-block mr-1" />
                {{ plugin.enabled ? "禁用" : "启用" }}
              </button>
              <button
                class="px-2.5 py-1.5 rounded-sm bg-ui-bg border border-ui-border text-[12px] hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                :disabled="actionPluginId === plugin.id"
                @click="handleUnregister(plugin)"
              >
                <Trash2 :size="13" class="inline-block mr-1" />
                卸载
              </button>
            </div>
          </li>
        </ul>
      </section>

      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">LLM Provider Registry</h3>
        <div v-if="llmProviders.length === 0" class="rounded-md border border-ui-border bg-ui-surface/20 px-3 py-2 text-[12px] text-ui-text-muted">
          暂无 provider
        </div>
        <ul v-else class="space-y-1.5 text-[12px]">
          <li v-for="(provider, idx) in llmProviders" :key="`${provider.id || 'provider'}-${idx}`" class="rounded border border-ui-border bg-ui-bg px-2.5 py-1.5 text-ui-text-muted">
            {{ providerSummary(provider) }}
          </li>
        </ul>
      </section>

      <p v-if="pageError" class="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{{ pageError }}</p>
    </div>
  </div>
</template>
