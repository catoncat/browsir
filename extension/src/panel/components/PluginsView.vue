<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRuntimeStore, type PluginMetadata, type PluginUiExtensionMetadata } from "../stores/runtime";
import { ArrowLeft, RefreshCcw, Power, Trash2, Code2 } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();

const dialogRef = ref<HTMLElement | null>(null);
const loading = ref(false);
const actionPluginId = ref("");
const pageError = ref("");
const plugins = ref<PluginMetadata[]>([]);
const uiExtensions = ref<PluginUiExtensionMetadata[]>([]);

const BUILTIN_PLUGIN_ID_PREFIX = "runtime.builtin.plugin.";
const EXAMPLE_PLUGIN_ID_PREFIX = "plugin.example.";
const isStandaloneStudioPage = ref(false);

const userPlugins = computed(() =>
  plugins.value.filter((p) => {
    const id = String(p.id || "").trim();
    return !id.startsWith(BUILTIN_PLUGIN_ID_PREFIX) && !id.startsWith(EXAMPLE_PLUGIN_ID_PREFIX);
  })
);

const examplePlugins = computed(() =>
  plugins.value.filter((p) => {
    const id = String(p.id || "").trim();
    return id.startsWith(EXAMPLE_PLUGIN_ID_PREFIX);
  })
);

function isExamplePlugin(plugin: PluginMetadata): boolean {
  return String(plugin.id || "").trim().startsWith(EXAMPLE_PLUGIN_ID_PREFIX);
}

function setPageError(error: unknown) {
  pageError.value = error instanceof Error ? error.message : String(error || "未知错误");
}

function formatList(values: string[]): string {
  if (!values.length) return "无";
  return values.join(", ");
}

interface PluginUsageRow {
  label: string;
  value: string;
}

function isBuiltinPlugin(plugin: PluginMetadata): boolean {
  return String(plugin.id || "").trim().startsWith(BUILTIN_PLUGIN_ID_PREFIX);
}

function findUiExtension(pluginId: string): PluginUiExtensionMetadata | null {
  const id = String(pluginId || "").trim();
  if (!id) return null;
  return uiExtensions.value.find((item) => String(item.pluginId || "").trim() === id) || null;
}

function formatUiExtensionSummary(pluginId: string): string {
  const ext = findUiExtension(pluginId);
  if (!ext) return "无";
  return `${ext.enabled ? "enabled" : "disabled"} · ${ext.exportName || "default"} · ${ext.moduleUrl}`;
}

function buildPluginUsageRows(plugin: PluginMetadata): PluginUsageRow[] {
  const rows: PluginUsageRow[] = [];
  const push = (label: string, values: string[]) => {
    if (!values.length) return;
    rows.push({ label, value: values.join(", ") });
  };
  push("hooks", plugin.hooks);
  push("modes", plugin.modes);
  push("capabilities", plugin.capabilities);
  push("policyCapabilities", plugin.policyCapabilities);
  push("tools", plugin.tools);
  push("runtimeMessages", plugin.runtimeMessages);
  push("brainEvents", plugin.brainEvents);
  const uiSummary = formatUiExtensionSummary(plugin.id);
  if (uiSummary !== "无") {
    rows.push({
      label: "uiExtension",
      value: uiSummary
    });
  }
  if (plugin.usageTotalCalls > 0 || plugin.usageTotalErrors > 0 || plugin.usageTotalTimeouts > 0) {
    rows.push({
      label: "usage.calls",
      value: String(plugin.usageTotalCalls)
    });
    rows.push({
      label: "usage.errors",
      value: String(plugin.usageTotalErrors)
    });
    rows.push({
      label: "usage.timeouts",
      value: String(plugin.usageTotalTimeouts)
    });
    if (plugin.usageLastUsedAt) {
      rows.push({
        label: "usage.lastUsedAt",
        value: plugin.usageLastUsedAt
      });
    }
    const topHookCalls = Object.entries(plugin.usageHookCalls || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([hook, count]) => `${hook}:${count}`);
    if (topHookCalls.length > 0) {
      rows.push({
        label: "usage.hooks",
        value: topHookCalls.join(", ")
      });
    }
  }
  return rows;
}

function pluginUsageKind(plugin: PluginMetadata): string {
  const traits: string[] = [];
  if (plugin.hooks.length > 0) traits.push("Hook");
  if (plugin.modes.length > 0 || plugin.capabilities.length > 0 || plugin.policyCapabilities.length > 0) traits.push("执行链");
  if (plugin.tools.length > 0) traits.push("Tool Contract");
  if (plugin.runtimeMessages.length > 0 || plugin.brainEvents.length > 0) traits.push("UI/事件输出");
  if (formatUiExtensionSummary(plugin.id) !== "无") traits.push("UI Extension");
  if (plugin.usageTotalCalls > 0) traits.push("已执行");
  if (!traits.length) return "未声明";
  return traits.join(" + ");
}

async function refreshPlugins() {
  loading.value = true;
  pageError.value = "";
  try {
    const out = await store.listPlugins();
    plugins.value = out.plugins;
    uiExtensions.value = out.uiExtensions;
  } catch (error) {
    setPageError(error);
  } finally {
    loading.value = false;
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
  if (isBuiltinPlugin(plugin)) {
    pageError.value = `内置插件不允许卸载: ${pluginId}`;
    return;
  }
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

async function handleOpenStandaloneStudio() {
  pageError.value = "";
  try {
    const url = chrome.runtime.getURL("plugin-studio.html");
    await chrome.tabs.create({ url });
  } catch (error) {
    setPageError(error);
  }
}

onMounted(async () => {
  const path = String(globalThis.location?.pathname || "").trim().toLowerCase();
  isStandaloneStudioPage.value = path.endsWith("/plugin-studio.html");
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
        v-if="!isStandaloneStudioPage"
        class="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ui-accent/10 border border-ui-accent/30 text-[12px] font-semibold text-ui-accent hover:bg-ui-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="打开 Plugin Studio 开发工作台"
        @click="handleOpenStandaloneStudio"
      >
        <Code2 :size="14" aria-hidden="true" />
        开发工作台
      </button>
      <button
        class="p-2 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
        :disabled="loading"
        aria-label="刷新插件列表"
        @click="refreshPlugins"
      >
        <RefreshCcw :size="16" :class="loading ? 'animate-spin' : ''" />
      </button>
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-6">
      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">已安装插件</h3>
        <div v-if="userPlugins.length === 0" class="rounded-md border border-ui-border bg-ui-surface/20 px-3 py-2 text-[12px] text-ui-text-muted">
          暂无用户插件。可前往<button class="text-ui-accent underline mx-0.5" @click="handleOpenStandaloneStudio">开发工作台</button>创建或安装插件。
        </div>
        <ul v-else class="space-y-2">
          <li v-for="plugin in userPlugins" :key="plugin.id" class="rounded-md border border-ui-border bg-ui-surface/20 px-3 py-2 space-y-2">
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
            <div class="rounded border border-ui-border/70 bg-ui-bg px-2.5 py-2 text-[11px] text-ui-text-muted space-y-1.5">
              <p><span class="font-semibold text-ui-text">类型:</span> {{ pluginUsageKind(plugin) }}</p>
              <template v-if="buildPluginUsageRows(plugin).length > 0">
                <p
                  v-for="row in buildPluginUsageRows(plugin)"
                  :key="`${plugin.id}-${row.label}`"
                >
                  <span class="font-semibold text-ui-text">{{ row.label }}:</span> {{ row.value }}
                </p>
              </template>
              <p v-else>未声明可观测使用项</p>
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
                :disabled="actionPluginId === plugin.id || isBuiltinPlugin(plugin)"
                @click="handleUnregister(plugin)"
              >
                <Trash2 :size="13" class="inline-block mr-1" />
                {{ isBuiltinPlugin(plugin) ? "内置不可卸载" : "卸载" }}
              </button>
            </div>
          </li>
        </ul>
      </section>

      <p v-if="pageError" class="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{{ pageError }}</p>

      <section v-if="examplePlugins.length > 0" class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">示例插件</h3>
        <ul class="space-y-2">
          <li v-for="plugin in examplePlugins" :key="plugin.id" class="rounded-md border border-ui-border bg-ui-surface/20 px-3 py-2 space-y-2">
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
    </div>
  </div>
</template>
