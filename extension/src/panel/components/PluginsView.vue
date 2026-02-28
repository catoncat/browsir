<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRuntimeStore, type PluginMetadata, type PluginUiExtensionMetadata } from "../stores/runtime";
import { ArrowLeft, Loader2, RefreshCcw, Power, Trash2, Plus, WandSparkles, ExternalLink } from "lucide-vue-next";

interface PluginPreset {
  id: string;
  name: string;
  description: string;
  replace: boolean;
  enable: boolean;
  plugin: Record<string, unknown>;
}

const emit = defineEmits(["close"]);
const store = useRuntimeStore();

const dialogRef = ref<HTMLElement | null>(null);
const loading = ref(false);
const registering = ref(false);
const actionPluginId = ref("");
const pageError = ref("");
const plugins = ref<PluginMetadata[]>([]);
const llmProviders = ref<Array<Record<string, unknown>>>([]);
const uiExtensions = ref<PluginUiExtensionMetadata[]>([]);

const replaceOnRegister = ref(true);
const enableOnRegister = ref(true);
const selectedPresetId = ref("");
const pluginJson = ref("");
const packageLocation = ref("mem://plugins/demo/plugin.json");
const BUILTIN_PLUGIN_ID_PREFIX = "runtime.builtin.plugin.";
const isStandaloneStudioPage = ref(false);

const presets: PluginPreset[] = [
  {
    id: "preset-llm-proxy-basic",
    name: "LLM Proxy（新增 provider）",
    description: "新增一个独立 provider，不覆盖系统默认 openai_compatible。",
    replace: true,
    enable: true,
    plugin: {
      manifest: {
        id: "plugin.preset.llm.proxy.basic",
        name: "preset-llm-proxy-basic",
        version: "1.0.0",
        permissions: {
          llmProviders: ["proxy.route.basic"]
        }
      },
      llmProviders: [
        {
          id: "proxy.route.basic",
          transport: "openai_compatible",
          baseUrl: "https://proxy.example.com/v1"
        }
      ]
    }
  },
  {
    id: "preset-llm-replace-openai",
    name: "LLM Proxy（覆盖默认 provider）",
    description: "把 openai_compatible 路由切到代理地址。禁用/卸载插件后可回滚。",
    replace: true,
    enable: true,
    plugin: {
      manifest: {
        id: "plugin.preset.llm.replace.openai",
        name: "preset-llm-replace-openai",
        version: "1.0.0",
        permissions: {
          llmProviders: ["openai_compatible"],
          replaceLlmProviders: true
        }
      },
      llmProviders: [
        {
          id: "openai_compatible",
          transport: "openai_compatible",
          baseUrl: "https://proxy.example.com/v1"
        }
      ]
    }
  },
  {
    id: "preset-browser-action-strict",
    name: "browser.action 严格校验",
    description: "把 browser.action 的 verify 策略提升为 always，减少“执行成功但无进展”。",
    replace: true,
    enable: true,
    plugin: {
      manifest: {
        id: "plugin.preset.browser.action.strict",
        name: "preset-browser-action-strict",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"]
        }
      },
      policies: {
        capabilities: {
          "browser.action": {
            defaultVerifyPolicy: "always",
            leasePolicy: "required"
          }
        }
      }
    }
  },
  {
    id: "preset-browser-verify-relaxed",
    name: "browser.action 宽松校验",
    description: "把 browser.action 的 verify 策略改为 on_critical，适合探索式任务。",
    replace: true,
    enable: true,
    plugin: {
      manifest: {
        id: "plugin.preset.browser.action.relaxed",
        name: "preset-browser-verify-relaxed",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"]
        }
      },
      policies: {
        capabilities: {
          "browser.action": {
            defaultVerifyPolicy: "on_critical",
            leasePolicy: "required"
          }
        }
      }
    }
  }
];

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

function providerSummary(row: Record<string, unknown>): string {
  const id = String(row.id || "").trim() || "unknown";
  const transport = String(row.transport || "custom").trim();
  return `${id} (${transport})`;
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
  push("llmProviders", plugin.llmProviders);
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
  if (plugin.llmProviders.length > 0) traits.push("LLM Provider");
  if (plugin.runtimeMessages.length > 0 || plugin.brainEvents.length > 0) traits.push("UI/事件输出");
  if (formatUiExtensionSummary(plugin.id) !== "无") traits.push("UI Extension");
  if (plugin.usageTotalCalls > 0) traits.push("已执行");
  if (!traits.length) return "未声明";
  return traits.join(" + ");
}

function deepCloneRecord(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readTextField(row: Record<string, unknown>, key: string): string {
  return String(row[key] || "").trim();
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

function applyPreset(preset: PluginPreset) {
  selectedPresetId.value = preset.id;
  replaceOnRegister.value = preset.replace;
  enableOnRegister.value = preset.enable;
  pluginJson.value = JSON.stringify(preset.plugin, null, 2);
}

async function installPreset(preset: PluginPreset) {
  registering.value = true;
  pageError.value = "";
  try {
    await store.registerPlugin(deepCloneRecord(preset.plugin), {
      replace: preset.replace,
      enable: preset.enable
    });
    applyPreset(preset);
    await refreshPlugins();
  } catch (error) {
    setPageError(error);
  } finally {
    registering.value = false;
  }
}

async function refreshPlugins() {
  loading.value = true;
  pageError.value = "";
  try {
    const out = await store.listPlugins();
    plugins.value = out.plugins;
    llmProviders.value = out.llmProviders;
    uiExtensions.value = out.uiExtensions;
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
    const manifest = toRecord(plugin.manifest);
    const moduleUrl = readTextField(plugin, "moduleUrl");
    const modulePath = readTextField(plugin, "modulePath");
    const moduleName = readTextField(plugin, "module");
    const exportName = readTextField(plugin, "exportName");
    if (Object.keys(manifest).length > 0 && (moduleUrl || modulePath || moduleName)) {
      await store.registerPluginExtension(
        {
          manifest,
          ...(moduleUrl ? { moduleUrl } : {}),
          ...(modulePath ? { modulePath } : {}),
          ...(moduleName ? { module: moduleName } : {}),
          ...(exportName ? { exportName } : {})
        },
        {
          replace: replaceOnRegister.value,
          enable: enableOnRegister.value
        }
      );
    } else {
      await store.registerPlugin(plugin, {
        replace: replaceOnRegister.value,
        enable: enableOnRegister.value
      });
    }
    await refreshPlugins();
  } catch (error) {
    setPageError(error);
  } finally {
    registering.value = false;
  }
}

async function handleInstallFromPackageLocation() {
  registering.value = true;
  pageError.value = "";
  try {
    const location = String(packageLocation.value || "").trim();
    if (!location) {
      throw new Error("插件包路径不能为空");
    }
    await store.installPlugin(
      {
        location,
        sessionId: String(store.activeSessionId || "").trim() || undefined
      },
      {
        replace: replaceOnRegister.value,
        enable: enableOnRegister.value
      }
    );
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
  applyPreset(presets[0]);
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
        class="ml-auto p-2 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="在独立页面打开插件管理"
        title="在独立页面打开"
        @click="handleOpenStandaloneStudio"
      >
        <ExternalLink :size="16" />
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
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">示例插件模板（初始化可用）</h3>
        <ul class="space-y-2">
          <li
            v-for="preset in presets"
            :key="preset.id"
            class="rounded-md border px-3 py-2.5"
            :class="selectedPresetId === preset.id ? 'border-ui-accent bg-ui-accent/5' : 'border-ui-border bg-ui-surface/20'"
          >
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-[13px] font-semibold text-ui-text">{{ preset.name }}</p>
                <p class="text-[11px] text-ui-text-muted mt-0.5">{{ preset.description }}</p>
              </div>
              <div class="flex items-center gap-1.5">
                <button
                  class="px-2 py-1 rounded-sm bg-ui-bg border border-ui-border text-[11px] hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  @click="applyPreset(preset)"
                >
                  加载
                </button>
                <button
                  class="px-2 py-1 rounded-sm bg-ui-bg border border-ui-border text-[11px] hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                  :disabled="registering"
                  @click="installPreset(preset)"
                >
                  <WandSparkles :size="12" class="inline-block mr-1" />
                  一键安装
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">高级模式（JSON）</h3>
        <p class="text-[11px] text-ui-text-muted">
          这里走 `brain.plugin.register`。用于声明式插件（LLM Provider / Policy / ToolContract）。
        </p>
        <p class="text-[11px] text-ui-text-muted">
          若 JSON 内包含 `manifest + moduleUrl/modulePath/module`，会自动切到 `brain.plugin.register_extension`。
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
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">插件包安装（mem://）</h3>
        <p class="text-[11px] text-ui-text-muted">
          走 `brain.plugin.install`，从浏览器虚拟文件系统读取插件包 JSON。
        </p>
        <div class="flex items-center gap-2">
          <input
            v-model="packageLocation"
            type="text"
            class="flex-1 bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[12px] font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            aria-label="插件包路径"
            placeholder="mem://plugins/demo/plugin.json"
          />
          <button
            class="px-3 py-2 rounded-sm bg-ui-surface border border-ui-border text-[12px] font-semibold hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
            :disabled="registering"
            @click="handleInstallFromPackageLocation"
          >
            <Loader2 v-if="registering" :size="14" class="inline-block animate-spin mr-1" />
            从包安装
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
