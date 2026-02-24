<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, watch } from "vue";
import { useRuntimeStore } from "../stores/runtime";
import { collectDiagnostics } from "../utils/diagnostics";
import { Server, Radio, Activity, RefreshCw, ArrowLeft, Copy, Check, Clock3 } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();
const { health, sessions, activeSessionId } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const loading = ref(false);
const copying = ref(false);
const copied = ref(false);
const autoRefresh = ref(true);
const error = ref("");
const selectedSessionId = ref("");
const diagnosticsText = ref("");
const diagnosticsPayload = ref<Record<string, unknown> | null>(null);

function sessionTitle(value: unknown) {
  const text = String(value || "").trim();
  return text || "未命名会话";
}

function shortId(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "N/A";
  return text.length > 14 ? `${text.slice(0, 6)}...${text.slice(-6)}` : text;
}

const summary = computed(() => {
  const raw = diagnosticsPayload.value?.summary;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
});

const timeline = computed(() => {
  const rows = diagnosticsPayload.value?.timeline;
  return Array.isArray(rows) ? rows.map((item) => String(item || "")).filter(Boolean) : [];
});

const recentEvents = computed(() => {
  const rows = diagnosticsPayload.value?.recentEvents;
  return Array.isArray(rows) ? rows.map((item) => String(item || "")).filter(Boolean) : [];
});

const currentSessionId = computed(() => {
  const selected = String(selectedSessionId.value || "").trim();
  if (selected) return selected;
  return String(activeSessionId.value || "").trim();
});

const currentSessionTitle = computed(() => {
  const matched = sessions.value.find((item) => String(item.id || "") === currentSessionId.value);
  return sessionTitle(matched?.title);
});

const sessionLabel = computed(() => currentSessionTitle.value);

function sessionOptionLabel(session: { id?: string; title?: string; updatedAt?: string }) {
  const title = sessionTitle(session?.title);
  const id = shortId(session?.id);
  return `${title} · ${id}`;
}

function syncSelectedSession() {
  const selected = String(selectedSessionId.value || "").trim();
  if (selected && sessions.value.some((item) => item.id === selected)) return;
  const active = String(activeSessionId.value || "").trim();
  if (active && sessions.value.some((item) => item.id === active)) {
    selectedSessionId.value = active;
    return;
  }
  selectedSessionId.value = sessions.value[0]?.id || "";
}

async function refreshReport(silent = false) {
  if (!silent) loading.value = true;
  error.value = "";
  try {
    await Promise.all([store.refreshHealth(), store.refreshSessions()]);
    syncSelectedSession();
    const { payload, text } = await collectDiagnostics({
      sessionId: currentSessionId.value || undefined,
      timelineLimit: 40
    });
    diagnosticsPayload.value = payload;
    diagnosticsText.value = text;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (!silent) loading.value = false;
  }
}

async function handleCopyReport() {
  if (copying.value) return;
  copying.value = true;
  try {
    if (!diagnosticsText.value.trim()) {
      await refreshReport(true);
    }
    await navigator.clipboard.writeText(diagnosticsText.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1800);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    copying.value = false;
  }
}

watch(activeSessionId, () => {
  syncSelectedSession();
});

useIntervalFn(() => {
  if (!autoRefresh.value || loading.value) return;
  void refreshReport(true);
}, 2800);

onMounted(() => {
  syncSelectedSession();
  dialogRef.value?.focus();
  void refreshReport();
});
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="运行调试"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="关闭调试面板"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" />
      </button>
      <h2 class="ml-2 font-bold text-[14px] text-ui-text tracking-tight">运行调试</h2>
      <div class="ml-auto flex items-center gap-0.5" role="toolbar" aria-label="调试操作">
        <button
          class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :class="autoRefresh ? 'text-ui-accent bg-ui-accent/10' : ''"
          :title="autoRefresh ? '关闭自动刷新' : '开启自动刷新'"
          :aria-label="autoRefresh ? '关闭自动刷新' : '开启自动刷新'"
          @click="autoRefresh = !autoRefresh"
        >
          <Clock3 :size="16" aria-hidden="true" />
        </button>
        <button
          class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :disabled="loading"
          title="刷新"
          aria-label="刷新调试信息"
          @click="refreshReport()"
        >
          <RefreshCw :size="16" :class="loading ? 'animate-spin' : ''" aria-hidden="true" />
        </button>
        <button
          class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :disabled="copying"
          :title="copied ? '已复制' : '复制诊断信息'"
          :aria-label="copied ? '已复制' : '复制诊断信息'"
          @click="handleCopyReport"
        >
          <Check v-if="copied" :size="16" class="text-emerald-600" aria-hidden="true" />
          <Copy v-else :size="16" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-4">
      <section class="rounded-md border border-ui-border bg-ui-surface/40 p-3 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-[11px] font-semibold text-ui-text-muted">会话</label>
          <select
            v-model="selectedSessionId"
            class="h-8 min-w-[220px] rounded border border-ui-border bg-ui-bg px-2 text-[12px] text-ui-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            @change="refreshReport()"
          >
            <option value="">当前活跃会话</option>
            <option v-for="session in sessions" :key="session.id" :value="session.id">
              {{ sessionOptionLabel(session) }}
            </option>
          </select>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          <div class="rounded border border-ui-border bg-ui-bg p-2.5">
            <div class="text-[10px] uppercase tracking-wider text-ui-text-muted flex items-center gap-1">
              <Server :size="12" /> Bridge
            </div>
            <p class="mt-1 text-[12px] font-semibold text-ui-text">{{ health.bridgeUrl ? "在线" : "离线" }}</p>
            <p class="text-[10px] text-ui-text-muted truncate">{{ health.bridgeUrl || "未配置" }}</p>
          </div>
          <div class="rounded border border-ui-border bg-ui-bg p-2.5">
            <div class="text-[10px] uppercase tracking-wider text-ui-text-muted flex items-center gap-1">
              <Radio :size="12" /> LLM
            </div>
            <p class="mt-1 text-[12px] font-semibold text-ui-text">{{ health.llmModel || "N/A" }}</p>
            <p class="text-[10px] text-ui-text-muted">{{ health.hasLlmApiKey ? "Key 已配置" : "Key 缺失" }}</p>
          </div>
          <div class="rounded border border-ui-border bg-ui-bg p-2.5">
            <div class="text-[10px] uppercase tracking-wider text-ui-text-muted flex items-center gap-1">
              <Activity :size="12" /> 会话
            </div>
            <p class="mt-1 text-[12px] font-semibold text-ui-text">{{ sessionLabel }}</p>
            <p class="text-[10px] text-ui-text-muted">
              消息 {{ Number(summary.messageCount || 0) }} · 步骤 {{ Number(summary.stepCount || 0) }}
            </p>
          </div>
          <div class="rounded border border-ui-border bg-ui-bg p-2.5">
            <div class="text-[10px] uppercase tracking-wider text-ui-text-muted">最近错误</div>
            <p class="mt-1 text-[12px] font-semibold" :class="summary.lastError ? 'text-rose-600' : 'text-emerald-600'">
              {{ summary.lastError ? "有" : "无" }}
            </p>
            <p class="text-[10px] text-ui-text-muted break-all">{{ String(summary.lastError || "未发现错误线索") }}</p>
          </div>
        </div>
      </section>

      <section class="rounded-md border border-ui-border bg-ui-bg">
        <header class="px-3 py-2 border-b border-ui-border text-[12px] font-semibold text-ui-text">关键轨迹</header>
        <div class="max-h-64 overflow-y-auto px-3 py-2.5">
          <ul v-if="timeline.length" class="space-y-1.5 text-[12px] text-ui-text">
            <li v-for="(line, idx) in timeline" :key="`${idx}-${line}`" class="rounded bg-ui-surface/60 px-2 py-1.5">
              {{ line }}
            </li>
          </ul>
          <p v-else class="text-[12px] text-ui-text-muted">暂无轨迹</p>
        </div>
      </section>

      <section class="rounded-md border border-ui-border bg-ui-bg">
        <header class="px-3 py-2 border-b border-ui-border text-[12px] font-semibold text-ui-text">最近事件（运行总线）</header>
        <div class="max-h-48 overflow-y-auto px-3 py-2.5">
          <ul v-if="recentEvents.length" class="space-y-1 text-[11px] text-ui-text-muted font-mono">
            <li v-for="(line, idx) in recentEvents" :key="`${idx}-${line}`">{{ line }}</li>
          </ul>
          <p v-else class="text-[12px] text-ui-text-muted">暂无事件</p>
        </div>
      </section>

      <details class="rounded-md border border-ui-border bg-ui-surface/20">
        <summary class="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold text-ui-text-muted">查看原始摘要 JSON</summary>
        <pre class="max-h-64 overflow-auto border-t border-ui-border px-3 py-2 text-[10px] leading-relaxed text-ui-text-muted">{{ JSON.stringify(diagnosticsPayload, null, 2) }}</pre>
      </details>

      <p v-if="error" class="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{{ error }}</p>
    </div>
  </div>
</template>
