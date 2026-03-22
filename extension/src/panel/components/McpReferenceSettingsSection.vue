<script setup lang="ts">
import { ref, watch } from "vue";
import { KeyRound, Plus, Trash2 } from "lucide-vue-next";
import {
  normalizeMcpRefConfig,
  type McpRefConfig,
} from "../../shared/mcp-config";

interface AuthPresetRow {
  name: string;
  value: string;
}

interface EnvPresetRow {
  name: string;
  value: string;
}

const props = defineProps<{
  modelValue: McpRefConfig;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: McpRefConfig];
}>();

const authRows = ref<AuthPresetRow[]>([]);
const envRows = ref<EnvPresetRow[]>([]);

function formatEnvInput(value: Record<string, string> | undefined): string {
  if (!value) return "";
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("\n");
}

function parseEnvInput(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function syncRowsFromValue(value: McpRefConfig): void {
  const normalized = normalizeMcpRefConfig(value);
  authRows.value = Object.entries(normalized.auth || {}).map(([name, item]) => ({
    name,
    value: item,
  }));
  envRows.value = Object.entries(normalized.env || {}).map(([name, item]) => ({
    name,
    value: formatEnvInput(item),
  }));
}

watch(
  () => props.modelValue,
  (value) => {
    syncRowsFromValue(value);
  },
  {
    immediate: true,
    deep: true,
  },
);

function emitValue(): void {
  const auth: Record<string, string> = {};
  for (const row of authRows.value) {
    const name = String(row.name || "").trim();
    const value = String(row.value || "").trim();
    if (!name || !value) continue;
    auth[name] = value;
  }

  const env: Record<string, Record<string, string>> = {};
  for (const row of envRows.value) {
    const name = String(row.name || "").trim();
    if (!name) continue;
    const parsed = parseEnvInput(String(row.value || ""));
    if (Object.keys(parsed).length <= 0) continue;
    env[name] = parsed;
  }

  emit(
    "update:modelValue",
    normalizeMcpRefConfig({
      ...(Object.keys(auth).length > 0 ? { auth } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }),
  );
}

function patchAuthRow(index: number, patch: Partial<AuthPresetRow>): void {
  authRows.value = authRows.value.map((row, rowIndex) =>
    rowIndex === index ? { ...row, ...patch } : row,
  );
  emitValue();
}

function patchEnvRow(index: number, patch: Partial<EnvPresetRow>): void {
  envRows.value = envRows.value.map((row, rowIndex) =>
    rowIndex === index ? { ...row, ...patch } : row,
  );
  emitValue();
}

function handleAddAuthRow(): void {
  authRows.value = [...authRows.value, { name: "", value: "" }];
  emitValue();
}

function handleDeleteAuthRow(index: number): void {
  authRows.value = authRows.value.filter((_, rowIndex) => rowIndex !== index);
  emitValue();
}

function handleAddEnvRow(): void {
  envRows.value = [...envRows.value, { name: "", value: "" }];
  emitValue();
}

function handleDeleteEnvRow(index: number): void {
  envRows.value = envRows.value.filter((_, rowIndex) => rowIndex !== index);
  emitValue();
}
</script>

<template>
  <section class="rounded-sm border border-ui-border bg-ui-surface/30 p-4 space-y-5">
    <div class="space-y-1">
      <h3 class="text-[13px] font-semibold text-ui-text">引用预设</h3>
      <p class="text-[12px] leading-relaxed text-ui-text-muted">
        统一管理可复用的认证值和环境变量组合，服务器里只保留引用名。
      </p>
    </div>

    <div class="space-y-3">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div class="space-y-0.5">
          <h4 class="text-[12px] font-semibold text-ui-text">认证预设</h4>
          <p class="text-[11px] text-ui-text-muted">
            这里的值会写入远程服务器的 `authorization` 请求头。
          </p>
        </div>
        <button
          type="button"
          data-mcp-auth-add
          class="w-full rounded-sm border border-ui-border px-3 py-2 text-[12px] font-semibold text-ui-text hover:bg-ui-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent sm:w-auto"
          @click="handleAddAuthRow"
        >
          <Plus :size="14" class="mr-1.5 inline-block" aria-hidden="true" />
          新增认证
        </button>
      </div>

      <div
        v-if="authRows.length <= 0"
        class="rounded-sm border border-dashed border-ui-border px-3 py-4 text-[12px] leading-relaxed text-ui-text-muted"
      >
        还没有认证预设。只有远程服务需要复用认证时再添加。
      </div>

      <div v-else class="space-y-2">
        <article
          v-for="(row, index) in authRows"
          :key="`auth-${index}`"
          class="rounded-sm border border-ui-border bg-ui-bg/60 p-3"
        >
          <div class="grid gap-3 lg:grid-cols-[160px_minmax(0,1fr)_auto] lg:items-start">
            <label class="block space-y-1.5">
              <span class="block text-[11px] font-semibold text-ui-text-muted">引用名</span>
              <input
                :value="row.name"
                :data-mcp-auth-name="index"
                type="text"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="例如 hey_grok_token"
                @input="patchAuthRow(index, { name: ($event.target as HTMLInputElement).value })"
              />
            </label>

            <label class="block space-y-1.5">
              <span class="block text-[11px] font-semibold text-ui-text-muted">认证值</span>
              <div class="relative">
                <KeyRound
                  :size="14"
                  class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ui-text-muted"
                  aria-hidden="true"
                />
                <input
                  :value="row.value"
                  :data-mcp-auth-value="index"
                  type="text"
                  class="w-full rounded-sm border border-ui-border bg-ui-bg py-2 pl-9 pr-3 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  placeholder="例如 Bearer xxx"
                  @input="patchAuthRow(index, { value: ($event.target as HTMLInputElement).value })"
                />
              </div>
            </label>

            <button
              type="button"
              :data-mcp-auth-delete="index"
              class="shrink-0 self-end rounded-sm border border-ui-border px-2.5 py-2 text-ui-text-muted hover:bg-ui-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent lg:mt-6"
              aria-label="删除认证预设"
              @click="handleDeleteAuthRow(index)"
            >
              <Trash2 :size="15" aria-hidden="true" />
            </button>
          </div>
        </article>
      </div>
    </div>

    <div class="space-y-3">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div class="space-y-0.5">
          <h4 class="text-[12px] font-semibold text-ui-text">环境预设</h4>
          <p class="text-[11px] text-ui-text-muted">
            用于复用一整组环境变量，本地命令可以再补本次专属变量。
          </p>
        </div>
        <button
          type="button"
          data-mcp-env-preset-add
          class="w-full rounded-sm border border-ui-border px-3 py-2 text-[12px] font-semibold text-ui-text hover:bg-ui-bg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent sm:w-auto"
          @click="handleAddEnvRow"
        >
          <Plus :size="14" class="mr-1.5 inline-block" aria-hidden="true" />
          新增环境
        </button>
      </div>

      <div
        v-if="envRows.length <= 0"
        class="rounded-sm border border-dashed border-ui-border px-3 py-4 text-[12px] leading-relaxed text-ui-text-muted"
      >
        还没有环境预设。只有多个本地服务共用变量时再补这里。
      </div>

      <div v-else class="space-y-2">
        <article
          v-for="(row, index) in envRows"
          :key="`env-${index}`"
          class="rounded-sm border border-ui-border bg-ui-bg/60 p-3"
        >
          <div class="grid gap-3 lg:grid-cols-[160px_minmax(0,1fr)_auto] lg:items-start">
            <label class="block space-y-1.5">
              <span class="block text-[11px] font-semibold text-ui-text-muted">引用名</span>
              <input
                :value="row.name"
                :data-mcp-env-name="index"
                type="text"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="例如 filesystem_prod"
                @input="patchEnvRow(index, { name: ($event.target as HTMLInputElement).value })"
              />
            </label>

            <label class="block space-y-1.5">
              <span class="block text-[11px] font-semibold text-ui-text-muted">环境变量</span>
              <textarea
                :value="row.value"
                :data-mcp-env-value="index"
                rows="4"
                class="w-full rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent resize-y"
                placeholder="每行一个变量，例如&#10;NODE_ENV=production&#10;API_BASE=https://example.com"
                @input="patchEnvRow(index, { value: ($event.target as HTMLTextAreaElement).value })"
              />
            </label>

            <button
              type="button"
              :data-mcp-env-delete="index"
              class="shrink-0 self-end rounded-sm border border-ui-border px-2.5 py-2 text-ui-text-muted hover:bg-ui-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent lg:mt-6"
              aria-label="删除环境预设"
              @click="handleDeleteEnvRow(index)"
            >
              <Trash2 :size="15" aria-hidden="true" />
            </button>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
