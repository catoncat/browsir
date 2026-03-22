<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import { ArrowLeft, Loader2 } from "lucide-vue-next";
import { useConfigStore } from "../stores/config-store";
import McpServerSettingsSection from "./McpServerSettingsSection.vue";
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
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
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
          管理本地命令和远程服务接入，保存后自动同步工具
        </p>
      </div>
    </header>

    <main class="flex-1 overflow-y-auto p-4">
      <McpServerSettingsSection v-model="config.mcpServers" />
    </main>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="visibleError" class="text-[11px] text-red-500 mb-3 px-1">{{ visibleError }}</p>
      <button
        class="w-full bg-ui-text text-ui-bg py-2.5 rounded-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :disabled="savingConfig"
        @click="handleSave"
      >
        <Loader2 v-if="savingConfig" class="animate-spin" :size="16" />
        {{ savingConfig ? "保存中..." : "保存并应用" }}
      </button>
    </footer>
  </div>
</template>
