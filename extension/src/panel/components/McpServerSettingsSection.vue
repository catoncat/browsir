<script setup lang="ts">
import { ref, watch } from "vue";
import {
  ChevronDown,
  ChevronUp,
  Globe,
  Plus,
  Terminal,
  Trash2,
} from "lucide-vue-next";
import {
  createMcpServerId,
  type McpServerConfig,
} from "../../shared/mcp-config";

const props = defineProps<{
  modelValue: McpServerConfig[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: McpServerConfig[]];
}>();

const expandedIndex = ref<number | null>(null);
const servers = ref<McpServerConfig[]>(
  Array.isArray(props.modelValue)
    ? props.modelValue.map((item) => ({ ...item }))
    : [],
);

watch(
  () => props.modelValue,
  (value) => {
    servers.value = Array.isArray(value)
      ? value.map((item) => ({ ...item }))
      : [];
  },
  {
    deep: true,
  },
);

watch(
  () => servers.value.length,
  (length) => {
    if (expandedIndex.value == null) return;
    if (length <= 0) {
      expandedIndex.value = null;
      return;
    }
    if (expandedIndex.value >= length) {
      expandedIndex.value = length - 1;
    }
  },
);

function emitServers(next: McpServerConfig[]): void {
  servers.value = next.map((item) => ({ ...item }));
  emit(
    "update:modelValue",
    next.map((item) => ({ ...item })),
  );
}

function buildNextServerId(): string {
  const taken = new Set(
    servers.value
      .map((item) => createMcpServerId(item.id, ""))
      .filter(Boolean),
  );
  let index = servers.value.length + 1;
  let candidate = `mcp_server_${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `mcp_server_${index}`;
  }
  return candidate;
}

function createEmptyServer(): McpServerConfig {
  return {
    id: buildNextServerId(),
    label: "",
    enabled: true,
    transport: "stdio",
    command: "",
    args: [],
    cwd: "",
    url: "",
    envRef: "",
    authRef: "",
  };
}

function patchServer(index: number, patch: Partial<McpServerConfig>): void {
  emitServers(
    servers.value.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...patch } : item,
    ),
  );
}

function readInputValue(event: Event): string {
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return target.value;
  }
  return "";
}

function readCheckedValue(event: Event): boolean {
  const target = event.target;
  return target instanceof HTMLInputElement ? target.checked : false;
}

function handleAddServer(): void {
  emitServers([...servers.value, createEmptyServer()]);
  expandedIndex.value = servers.value.length;
}

function handleDeleteServer(index: number): void {
  emitServers(servers.value.filter((_, itemIndex) => itemIndex !== index));
  if (expandedIndex.value == null) return;
  if (expandedIndex.value === index) {
    expandedIndex.value = null;
    return;
  }
  if (expandedIndex.value > index) {
    expandedIndex.value -= 1;
  }
}

function handleToggleExpanded(index: number): void {
  expandedIndex.value = expandedIndex.value === index ? null : index;
}

function parseArgsInput(raw: string): string[] {
  return raw
    .split(/\r?\n/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatArgsInput(value: string[] | undefined): string {
  return Array.isArray(value) ? value.join("\n") : "";
}

function handleLabelBlur(index: number): void {
  const current = servers.value[index];
  if (!current) return;
  const currentId = String(current.id || "").trim();
  if (currentId && !/^mcp_server_\d+$/.test(currentId)) return;
  patchServer(index, {
    id: createMcpServerId(current.label, `mcp_server_${index + 1}`),
  });
}

function handleIdBlur(index: number): void {
  const current = servers.value[index];
  if (!current) return;
  patchServer(index, {
    id: createMcpServerId(
      current.id,
      current.label || `mcp_server_${index + 1}`,
    ),
  });
}

function previewServerId(server: McpServerConfig, index: number): string {
  return createMcpServerId(server.id, server.label || `mcp_server_${index + 1}`);
}

function serverTitle(server: McpServerConfig, index: number): string {
  return String(server.label || "").trim() || `服务器 ${index + 1}`;
}

function serverTransportLabel(server: McpServerConfig): string {
  return server.transport === "streamable-http" ? "远程 URL" : "本地命令";
}

function serverSummary(server: McpServerConfig): string {
  if (server.transport === "streamable-http") {
    return String(server.url || "").trim() || "还没有填写服务地址";
  }
  const command = String(server.command || "").trim();
  const args = Array.isArray(server.args) ? server.args.join(" ") : "";
  const summary = [command, args].filter(Boolean).join(" ");
  return summary || "还没有填写启动命令";
}

function hasAdvancedFields(server: McpServerConfig): boolean {
  return Boolean(
    String(server.envRef || "").trim() || String(server.authRef || "").trim(),
  );
}

function handleLabelInput(index: number, event: Event): void {
  patchServer(index, {
    label: readInputValue(event),
  });
}

function handleIdInput(index: number, event: Event): void {
  patchServer(index, {
    id: readInputValue(event),
  });
}

function handleEnabledChange(index: number, event: Event): void {
  patchServer(index, {
    enabled: readCheckedValue(event),
  });
}

function handleTransportChange(index: number, transport: "stdio" | "streamable-http"): void {
  patchServer(index, { transport });
}

function handleCommandInput(index: number, event: Event): void {
  patchServer(index, {
    command: readInputValue(event),
  });
}

function handleArgsInput(index: number, event: Event): void {
  patchServer(index, {
    args: parseArgsInput(readInputValue(event)),
  });
}

function handleCwdInput(index: number, event: Event): void {
  patchServer(index, {
    cwd: readInputValue(event),
  });
}

function handleUrlInput(index: number, event: Event): void {
  patchServer(index, {
    url: readInputValue(event),
  });
}

function handleEnvRefInput(index: number, event: Event): void {
  patchServer(index, {
    envRef: readInputValue(event),
  });
}

function handleAuthRefInput(index: number, event: Event): void {
  patchServer(index, {
    authRef: readInputValue(event),
  });
}
</script>

<template>
  <section class="rounded-sm border border-ui-border bg-ui-surface/30 p-4 space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div class="space-y-1">
        <h3 class="text-[13px] font-semibold text-ui-text">MCP 工具接入</h3>
        <p class="text-[12px] leading-relaxed text-ui-text-muted">
          把本地命令或远程服务接进系统。保存后会自动同步可用工具。
        </p>
      </div>
      <button
        type="button"
        data-mcp-add
        class="shrink-0 rounded-sm border border-ui-border px-3 py-2 text-[12px] font-semibold text-ui-text hover:bg-ui-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        @click="handleAddServer"
      >
        <Plus :size="14" class="inline-block mr-1.5" aria-hidden="true" />
        新增服务器
      </button>
    </div>

    <div
      v-if="servers.length <= 0"
      class="rounded-sm border border-dashed border-ui-border px-3 py-5 text-[12px] leading-relaxed text-ui-text-muted"
    >
      还没有添加 MCP 服务器。可以先接一个本地命令，后续再补远程服务。
    </div>

    <div v-else class="space-y-3">
      <article
        v-for="(server, index) in servers"
        :key="`${server.id || 'draft'}-${index}`"
        :data-mcp-server="index"
        class="overflow-hidden rounded-sm border border-ui-border bg-ui-bg/60"
      >
        <div class="flex items-start gap-3 px-3 py-3">
          <div
            class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-ui-border bg-ui-surface/60 text-ui-text-muted"
            aria-hidden="true"
          >
            <Globe v-if="server.transport === 'streamable-http'" :size="15" />
            <Terminal v-else :size="15" />
          </div>

          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <h4 class="text-[13px] font-semibold text-ui-text">
                {{ serverTitle(server, index) }}
              </h4>
              <span class="rounded-full bg-ui-surface px-2 py-0.5 text-[10px] font-semibold text-ui-text-muted">
                {{ serverTransportLabel(server) }}
              </span>
              <span
                v-if="server.enabled === false"
                class="rounded-full bg-ui-surface px-2 py-0.5 text-[10px] font-semibold text-ui-text-muted"
              >
                已暂停
              </span>
            </div>
            <p class="truncate text-[12px] text-ui-text">
              {{ serverSummary(server) }}
            </p>
            <p class="text-[11px] text-ui-text-muted">
              标识：{{ previewServerId(server, index) }}
            </p>
          </div>

          <label class="flex shrink-0 items-center gap-2 text-[12px] text-ui-text-muted">
            <span>启用</span>
            <input
              :checked="server.enabled !== false"
              :data-mcp-enabled="index"
              type="checkbox"
              class="h-4 w-4 rounded border-ui-border bg-ui-bg text-ui-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              @change="handleEnabledChange(index, $event)"
            />
          </label>

          <button
            type="button"
            :data-mcp-toggle="index"
            class="shrink-0 rounded-sm border border-ui-border px-2.5 py-2 text-ui-text-muted hover:bg-ui-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            :aria-expanded="expandedIndex === index"
            :aria-label="expandedIndex === index ? '收起服务器设置' : '展开服务器设置'"
            @click="handleToggleExpanded(index)"
          >
            <ChevronUp v-if="expandedIndex === index" :size="15" aria-hidden="true" />
            <ChevronDown v-else :size="15" aria-hidden="true" />
          </button>

          <button
            type="button"
            :data-mcp-delete="index"
            class="shrink-0 rounded-sm border border-ui-border px-2.5 py-2 text-ui-text-muted hover:bg-ui-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            aria-label="删除服务器"
            @click="handleDeleteServer(index)"
          >
            <Trash2 :size="15" aria-hidden="true" />
          </button>
        </div>

        <div
          v-if="expandedIndex === index"
          class="border-t border-ui-border bg-ui-surface/15 px-3 py-4 space-y-4"
        >
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block space-y-1.5">
              <span class="block text-[12px] font-semibold text-ui-text">名称</span>
              <input
                :value="server.label || ''"
                :data-mcp-field="`label-${index}`"
                type="text"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="例如 GitHub、文件系统"
                @input="handleLabelInput(index, $event)"
                @blur="handleLabelBlur(index)"
              />
            </label>

            <label class="block space-y-1.5">
              <span class="block text-[12px] font-semibold text-ui-text">标识</span>
              <input
                :value="server.id || ''"
                :data-mcp-field="`id-${index}`"
                type="text"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="例如 github"
                @input="handleIdInput(index, $event)"
                @blur="handleIdBlur(index)"
              />
              <p class="text-[11px] text-ui-text-muted">
                会自动规范成字母、数字和下划线，用于生成工具名。
              </p>
            </label>
          </div>

          <div class="space-y-2">
            <div class="text-[12px] font-semibold text-ui-text">连接方式</div>
            <div class="inline-flex rounded-sm border border-ui-border bg-ui-bg p-1">
              <button
                type="button"
                :data-mcp-transport="`stdio-${index}`"
                class="rounded-sm px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                :class="
                  server.transport === 'stdio'
                    ? 'bg-ui-text text-ui-bg'
                    : 'text-ui-text-muted hover:bg-ui-surface'
                "
                @click="handleTransportChange(index, 'stdio')"
              >
                本地命令
              </button>
              <button
                type="button"
                :data-mcp-transport="`streamable-http-${index}`"
                class="rounded-sm px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                :class="
                  server.transport === 'streamable-http'
                    ? 'bg-ui-text text-ui-bg'
                    : 'text-ui-text-muted hover:bg-ui-surface'
                "
                @click="handleTransportChange(index, 'streamable-http')"
              >
                远程 URL
              </button>
            </div>
          </div>

          <div v-if="server.transport === 'stdio'" class="space-y-3">
            <label class="block space-y-1.5">
              <span class="block text-[12px] font-semibold text-ui-text">启动命令</span>
              <input
                :value="server.command || ''"
                :data-mcp-field="`command-${index}`"
                type="text"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="例如 bun"
                @input="handleCommandInput(index, $event)"
              />
            </label>

            <label class="block space-y-1.5">
              <span class="block text-[12px] font-semibold text-ui-text">命令参数</span>
              <textarea
                :value="formatArgsInput(server.args)"
                :data-mcp-field="`args-${index}`"
                rows="4"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent resize-y"
                placeholder="每行一个参数，例如&#10;run&#10;start"
                @input="handleArgsInput(index, $event)"
              />
            </label>

            <label class="block space-y-1.5">
              <span class="block text-[12px] font-semibold text-ui-text">工作目录</span>
              <input
                :value="server.cwd || ''"
                :data-mcp-field="`cwd-${index}`"
                type="text"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="例如 /Users/name/work/project"
                @input="handleCwdInput(index, $event)"
              />
            </label>
          </div>

          <div v-else class="space-y-3">
            <label class="block space-y-1.5">
              <span class="block text-[12px] font-semibold text-ui-text">服务地址</span>
              <input
                :value="server.url || ''"
                :data-mcp-field="`url-${index}`"
                type="url"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="例如 https://mcp.example.com"
                @input="handleUrlInput(index, $event)"
              />
            </label>
          </div>

          <details
            class="rounded-sm border border-ui-border bg-ui-bg/70"
            :open="hasAdvancedFields(server)"
          >
            <summary class="cursor-pointer list-none px-3 py-2 text-[12px] font-semibold text-ui-text">
              高级选项
            </summary>
            <div class="grid gap-3 border-t border-ui-border px-3 py-3 sm:grid-cols-2">
              <label class="block space-y-1.5">
                <span class="block text-[12px] font-semibold text-ui-text">环境变量引用</span>
                <input
                  :value="server.envRef || ''"
                  :data-mcp-field="`envRef-${index}`"
                  type="text"
                  class="w-full rounded-sm border border-ui-border bg-ui-surface px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  placeholder="例如 host_env/github"
                  @input="handleEnvRefInput(index, $event)"
                />
              </label>

              <label class="block space-y-1.5">
                <span class="block text-[12px] font-semibold text-ui-text">认证引用</span>
                <input
                  :value="server.authRef || ''"
                  :data-mcp-field="`authRef-${index}`"
                  type="text"
                  class="w-full rounded-sm border border-ui-border bg-ui-surface px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  placeholder="例如 secret/github_token"
                  @input="handleAuthRefInput(index, $event)"
                />
              </label>
            </div>
          </details>
        </div>
      </article>
    </div>
  </section>
</template>
