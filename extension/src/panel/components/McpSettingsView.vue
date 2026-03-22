<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import { ArrowLeft, Loader2 } from "lucide-vue-next";
import { useConfigStore } from "../stores/config-store";
import McpServerSettingsSection from "./McpServerSettingsSection.vue";
import McpReferenceSettingsSection from "./McpReferenceSettingsSection.vue";
import { normalizeMcpServerList } from "../../shared/mcp-config";

const emit = defineEmits(["close"]);
const store = useConfigStore();
const { config, savingConfig, error } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const localError = ref("");

function validateMcpServers(): string {
  const servers = normalizeMcpServerList(config.value.mcpServers);
  for (const server of servers) {
    if (server.enabled === false) continue;
    if (server.transport === "stdio") {
      if (!String(server.command || "").trim()) {
        return `请先为 MCP 服务器 ${server.label || server.id} 填写启动命令。`;
      }
      continue;
    }

    const url = String(server.url || "").trim();
    if (!url) {
      return `请先为 MCP 服务器 ${server.label || server.id} 填写服务地址。`;
    }
    try {
      new URL(url);
    } catch {
      return `MCP 服务器 ${server.label || server.id} 的服务地址格式不正确。`;
    }
  }
  return "";
}

async function handleSave() {
  localError.value = "";
  const validationError = validateMcpServers();
  if (validationError) {
    localError.value = validationError;
    return;
  }

  try {
    await store.saveConfig();
    emit("close");
  } catch {
    // store.error is rendered below
  }
}

onMounted(() => {
  dialogRef.value?.focus();
});

const visibleError = computed(() => localError.value || error.value);
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="MCP 服务器"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header class="border-b border-ui-border bg-ui-bg shrink-0">
      <div class="mx-auto flex h-12 w-full max-w-[1120px] items-center px-2 sm:px-4">
        <button
          class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          aria-label="关闭 MCP 服务器设置"
          @click="$emit('close')"
        >
          <ArrowLeft :size="18" />
        </button>
        <div class="ml-2 min-w-0">
          <h2 class="font-bold text-[14px] text-ui-text tracking-tight">MCP 服务器</h2>
          <p class="text-[11px] text-ui-text-muted truncate">
            统一管理远程服务、本地命令，以及复用它们的认证与环境预设
          </p>
        </div>
      </div>
    </header>

    <main class="flex-1 overflow-y-auto bg-ui-bg px-3 py-4 sm:px-4 sm:py-5">
      <div class="mx-auto grid w-full max-w-[1120px] items-start gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,1fr)]">
        <McpServerSettingsSection v-model="config.mcpServers" />
        <div class="xl:sticky xl:top-5">
          <McpReferenceSettingsSection v-model="config.mcpRefs" />
        </div>
      </div>
    </main>

    <footer class="border-t border-ui-border bg-ui-surface/20 px-3 py-3 sm:px-4">
      <div class="mx-auto flex w-full max-w-[1120px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-[11px] leading-relaxed text-ui-text-muted sm:max-w-[420px]">
          保存后会立即刷新 MCP 工具注册；远程服务优先读取请求头，本地命令优先读取环境预设。
        </p>
        <div class="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[280px]">
          <p v-if="visibleError" class="text-[11px] text-red-500 sm:text-right">
            {{ visibleError }}
          </p>
          <button
            class="w-full rounded-sm bg-ui-text py-2.5 font-bold text-ui-bg flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent sm:w-auto sm:px-6"
            :disabled="savingConfig"
            @click="handleSave"
          >
            <Loader2 v-if="savingConfig" class="animate-spin" :size="16" />
            {{ savingConfig ? "保存中..." : "保存并应用" }}
          </button>
        </div>
      </div>
    </footer>
  </div>
</template>
