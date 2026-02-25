<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import {
  Sparkles,
  ChevronDown,
  ChevronUp,
  Loader2,
  Globe,
  Database,
  Cpu,
  Activity,
  Pencil,
  RotateCcw,
  GitBranch,
  Copy,
  Check,
  X
} from "lucide-vue-next";
import { resolveToolRender } from "../utils/tool-renderers";
import { IncremarkContent, ThemeProvider } from "@incremark/vue";
import IncremarkCodeBlock from "./IncremarkCodeBlock.vue";
import { usePanelDarkMode } from "../utils/use-panel-dark-mode";

interface ToolPendingStepData {
  step: number;
  status: "running" | "done" | "failed";
  line: string;
  logs?: string[];
}

const props = defineProps<{
  role: string;
  content: string;
  entryId: string;
  streamingMode?: "markdown" | "plain";
  toolName?: string;
  toolCallId?: string;
  toolPending?: boolean;
  toolPendingLeaving?: boolean;
  toolPendingStatus?: "running" | "done" | "failed";
  toolPendingHeadline?: string;
  toolPendingAction?: string;
  toolPendingDetail?: string;
  toolPendingSteps?: string[];
  toolPendingStepsData?: ToolPendingStepData[];
  copied?: boolean;
  retrying?: boolean;
  forking?: boolean;
  editing?: boolean;
  editDraft?: string;
  editSubmitting?: boolean;
  editDisabled?: boolean;
  copyDisabled?: boolean;
  retryDisabled?: boolean;
  forkDisabled?: boolean;
  showEditAction?: boolean;
  showCopyAction?: boolean;
  showRetryAction?: boolean;
  showForkAction?: boolean;
}>();

const emit = defineEmits<{
  (e: "copy", payload: { entryId: string; content: string; role: string }): void;
  (e: "edit", payload: { entryId: string; content: string; role: string }): void;
  (e: "edit-change", payload: { entryId: string; content: string }): void;
  (e: "edit-submit", payload: { entryId: string; content: string; role: string }): void;
  (e: "edit-cancel", payload: { entryId: string }): void;
  (e: "retry", payload: { entryId: string }): void;
  (e: "fork", payload: { entryId: string }): void;
}>();

const isUser = computed(() => props.role === "user");
const isSystem = computed(() => props.role === "system");
const isAssistant = computed(() => props.role === "assistant");
const isAssistantStreaming = computed(() => props.role === "assistant_streaming");
const isAssistantLike = computed(() => isAssistant.value || isAssistantStreaming.value);
const isStreamingPlainText = computed(() => isAssistantStreaming.value && props.streamingMode === "plain");
const hasAssistantContent = computed(() => String(props.content || "").trim().length > 0);
const isTool = computed(() => props.role === "tool");
const isToolPending = computed(() => props.role === "tool_pending" || props.toolPending === true);

const incremarkComponents = {
  code: IncremarkCodeBlock
};

const isDark = usePanelDarkMode();
const incremarkTheme = computed(() => isDark.value ? "dark" : "default");

const isFinished = computed(() => props.role !== "assistant_streaming");

const showThinking = ref(false);
const showSystemSummary = ref(false);
const inlineTextarea = ref<HTMLTextAreaElement | null>(null);
const pendingActivityViewport = ref<HTMLElement | null>(null);
const pendingCardStickToBottom = ref(true);
const pendingDetailsExpanded = ref(false);
const TOOL_COMPACT_LINE_MAX = 120;

const toolRender = computed(() =>
  resolveToolRender({
    content: props.content,
    toolName: props.toolName,
    toolCallId: props.toolCallId
  })
);
const isSummarySystemMessage = computed(() =>
  isSystem.value &&
  (String(props.entryId || "").startsWith("summary:") || String(props.content || "").startsWith("Previous summary:\n"))
);
const normalizedSystemContent = computed(() => {
  const content = String(props.content || "");
  if (!isSummarySystemMessage.value) return content;
  const prefix = "Previous summary:\n";
  if (!content.startsWith(prefix)) return content;
  return content.slice(prefix.length);
});
const toolTextContent = computed(() => {
  if (!isTool.value) return "";
  return toolRender.value.detail;
});
const messageAriaPreview = computed(() => {
  if (isSummarySystemMessage.value) return "历史摘要";
  if (isSystem.value) return "系统消息";
  if (isToolPending.value) {
    const action = props.toolPendingAction || props.toolName || "工具调用";
    const detail = String(props.toolPendingDetail || "").trim();
    return detail ? `正在执行：${action}，${detail}` : `正在执行：${action}`;
  }
  if (isTool.value) return toolRender.value.title;
  return props.content.slice(0, 50);
});

function clipInlineText(text: string, max = TOOL_COMPACT_LINE_MAX): string {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function normalizeToolHeadline(title: string): string {
  let value = String(title || "").trim();
  if (!value) return "工具调用";
  value = value.replace(/^已执行工具[:：]\s*/u, "");
  value = value.replace(/^已执行工具调用$/u, "工具调用");
  value = value.replace(/^已读取页面快照$/u, "snapshot");
  value = value.replace(/^已读取页面[:：]\s*/u, "snapshot · ");
  value = value.replace(/^已打开标签页$/u, "open_tab");
  value = value.replace(/^已获取\s*(\d+)\s*个标签页$/u, "tabs · $1");
  value = value.replace(/^浏览器动作已执行并通过验证$/u, "browser_action · verified");
  value = value.replace(/^浏览器动作已执行$/u, "browser_action");
  value = value.replace(/^工具调用失败[:：]\s*/u, "失败 · ");
  value = value.replace(/^工具失败[:：]\s*/u, "失败 · ");
  return value || "工具调用";
}

function normalizeToolSubtitle(subtitle: string): string {
  let value = String(subtitle || "").trim();
  if (!value) return "";
  value = value.replace(/\s*[·|]\s*调用\s*ID[:：][^·|]+/giu, "");
  value = value.replace(/调用\s*ID[:：][^·|]+/giu, "");
  value = value.replace(/^命令[:：]\s*/u, "");
  value = value.replace(/^路径[:：]\s*/u, "");
  value = value.replace(/^目标[:：]\s*/u, "");
  return value.trim();
}

const toolCompactLine = computed(() => {
  if (!isTool.value) return "";
  const head = normalizeToolHeadline(toolRender.value.title);
  const tail = normalizeToolSubtitle(toolRender.value.subtitle);
  return clipInlineText(tail ? `${head} · ${tail}` : head);
});

const toolToggleAriaLabel = computed(() =>
  showThinking.value ? "收起运行详情" : "展开运行详情"
);
const pendingToneClass = computed(() =>
  props.toolPendingStatus === "failed" ? "bg-rose-100/40 dark:bg-rose-900/20" : "bg-ui-surface/45"
);
const pendingToneTextClass = computed(() =>
  props.toolPendingStatus === "failed" ? "text-rose-700/90 dark:text-rose-300/90" : "text-ui-text"
);
const pendingCompactLine = computed(() => {
  const action = String(props.toolPendingAction || props.toolName || "tool").trim();
  const detail = normalizeToolSubtitle(String(props.toolPendingDetail || ""));
  const status = props.toolPendingStatus === "failed"
    ? "失败"
    : props.toolPendingStatus === "done"
      ? "完成"
      : "执行中";
  const base = [status, action].filter(Boolean).join(" · ");
  return clipInlineText(detail ? `${base} · ${detail}` : base);
});
const toolToneClass = computed(() => {
  if (toolRender.value.tone === "error") return "bg-rose-100/40 dark:bg-rose-900/20";
  if (toolRender.value.tone === "success") return "bg-ui-surface/45";
  return "bg-ui-surface/45";
});
const toolToneTextClass = computed(() => {
  if (toolRender.value.tone === "error") return "text-rose-700/90 dark:text-rose-300/90";
  if (toolRender.value.tone === "success") return "text-ui-text";
  return "text-ui-text";
});
const toolIcon = computed(() => {
  if (toolRender.value.tone === "error") return X;
  if (toolRender.value.kind === "tabs") return Globe;
  if (toolRender.value.kind === "snapshot") return Sparkles;
  if (toolRender.value.kind === "invoke") return Cpu;
  if (toolRender.value.kind === "browser") return Activity;
  return Database;
});
const pendingStepItems = computed(() => {
  if (Array.isArray(props.toolPendingStepsData) && props.toolPendingStepsData.length) {
    return props.toolPendingStepsData.map((item) => ({
      step: Number(item?.step || 0),
      status: item?.status === "failed" ? "failed" : item?.status === "done" ? "done" : "running",
      line: String(item?.line || "").trim(),
      logs: Array.isArray(item?.logs)
        ? item.logs.map((log) => String(log || "").trim()).filter((log) => log.length > 0)
        : []
    })).filter((item) => item.step > 0 && item.line.length > 0);
  }
  const fallbackSteps = Array.isArray(props.toolPendingSteps)
    ? props.toolPendingSteps.map((text) => String(text || "").trim()).filter((text) => text.length > 0)
    : [];
  return fallbackSteps.map((line, index) => ({
    step: index + 1,
    status: "running" as const,
    line,
    logs: []
  }));
});
const currentPendingStepItem = computed(() =>
  pendingStepItems.value.length ? pendingStepItems.value[pendingStepItems.value.length - 1] : null
);
const currentPendingLogs = computed(() =>
  Array.isArray(currentPendingStepItem.value?.logs) ? currentPendingStepItem.value?.logs || [] : []
);
const pendingRawDetail = computed(() => String(props.toolPendingDetail || "").trim());
const pendingDetailCompact = computed(() => normalizeToolSubtitle(pendingRawDetail.value));

function denoisePendingLog(line: string): string {
  let text = String(line || "").trim();
  if (!text) return "";

  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const event = String(payload?.event || "").trim();
      const data = payload?.data && typeof payload.data === "object"
        ? payload.data as Record<string, unknown>
        : {};

      if (event === "invoke.started") {
        const command = String(data.command || "").trim();
        return command ? `启动：${clipInlineText(command, TOOL_COMPACT_LINE_MAX)}` : "";
      }
      if (event === "invoke.finished") {
        const ok = data.ok === true;
        const exitCode = Number(data.exitCode);
        if (Number.isFinite(exitCode)) {
          return ok ? `已完成 · exitCode=${exitCode}` : `失败 · exitCode=${exitCode}`;
        }
        return ok ? "已完成" : "失败";
      }
      if (event === "invoke.stdout" || event === "invoke.stderr") {
        const chunk = String(data.chunk || "").trim();
        if (chunk) text = chunk;
      }
    } catch {
      // keep raw text fallback
    }
  }

  text = text
    .replace(/^stderr\s*\|\s*/iu, "")
    .replace(/^stdout\s*\|\s*/iu, "")
    .replace(/^\[(stderr|stdout)\]\s*/iu, "")
    .replace(/^(stderr|stdout)\s*[:：]\s*/iu, "")
    .trim();
  return text;
}

const denoisedPendingLogs = computed(() =>
  currentPendingLogs.value
    .map((line) => denoisePendingLog(line))
    .filter((line) => line.length > 0)
);
const pendingPreviewLine = computed(() => {
  if (pendingDetailCompact.value) return clipInlineText(pendingDetailCompact.value, TOOL_COMPACT_LINE_MAX);
  const logs = denoisedPendingLogs.value;
  if (logs.length) return clipInlineText(logs[logs.length - 1] || "", TOOL_COMPACT_LINE_MAX);
  if (props.toolPendingStatus === "failed") return "执行失败";
  if (props.toolPendingStatus === "done") return "执行完成";
  return "等待工具输出";
});
const hasPendingDetails = computed(() =>
  pendingRawDetail.value.length > 0 || denoisedPendingLogs.value.length > 0
);
const pendingDetailsToggleLabel = computed(() =>
  pendingDetailsExpanded.value ? "收起工具输出详情" : "展开工具输出详情"
);

function togglePendingDetails() {
  pendingDetailsExpanded.value = !pendingDetailsExpanded.value;
}

function toggleThinking() {
  showThinking.value = !showThinking.value;
}

function toggleSystemSummary() {
  showSystemSummary.value = !showSystemSummary.value;
}

function handleCopy() {
  emit("copy", { entryId: props.entryId, content: props.content, role: props.role });
}

function handleEdit() {
  emit("edit", { entryId: props.entryId, content: props.content, role: props.role });
}

function handleEditChange(event: Event) {
  const target = event.target as HTMLTextAreaElement | null;
  emit("edit-change", { entryId: props.entryId, content: String(target?.value || "") });
}

function handleEditCancel() {
  emit("edit-cancel", { entryId: props.entryId });
}

function handleEditSubmit() {
  const content = String(inlineTextarea.value?.value ?? props.editDraft ?? props.content ?? "");
  if (!content.trim()) return;
  emit("edit-submit", { entryId: props.entryId, content, role: props.role });
}

function handleEditKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    handleEditCancel();
    return;
  }
  if (event.key !== "Enter") return;
  if (event.shiftKey) return;
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  handleEditSubmit();
}

function handleRegenerate() {
  emit("retry", { entryId: props.entryId });
}

function handleFork() {
  emit("fork", { entryId: props.entryId });
}

function syncPendingActivityScroll(forceBottom = false) {
  const el = pendingActivityViewport.value;
  if (!el) return;
  if (!forceBottom && !pendingCardStickToBottom.value) return;
  el.scrollTop = el.scrollHeight;
}

function handlePendingActivityScroll() {
  const el = pendingActivityViewport.value;
  if (!el) return;
  const remain = el.scrollHeight - el.scrollTop - el.clientHeight;
  pendingCardStickToBottom.value = remain <= 14;
}

watch(
  () => props.editing,
  async (editing) => {
    if (!editing || !isUser.value) return;
    await nextTick();
    const target = inlineTextarea.value;
    if (!target) return;
    target.focus();
    const end = target.value.length;
    target.setSelectionRange(end, end);
  }
);

watch(
  () => props.entryId,
  () => {
    pendingDetailsExpanded.value = false;
    pendingCardStickToBottom.value = true;
  }
);

watch(
  () => currentPendingStepItem.value?.step || 0,
  () => {
    pendingDetailsExpanded.value = false;
    pendingCardStickToBottom.value = true;
  }
);

watch(
  () => pendingStepItems.value.map((item) => `${item.step}:${item.status}:${item.logs.length}`).join("|"),
  async () => {
    await nextTick();
    syncPendingActivityScroll();
  }
);

watch(
  () => isSummarySystemMessage.value,
  (isSummary) => {
    showSystemSummary.value = !isSummary;
  },
  { immediate: true }
);
</script>

<template>
  <div 
    class="flex flex-col animate-in fade-in duration-300 group"
    :class="isTool || isToolPending ? 'mb-1' : 'mb-2.5'"
    role="listitem"
    :aria-label="`${isUser ? '用户' : isSystem ? '系统' : isAssistantLike ? '助手' : '工具'}消息: ${messageAriaPreview}...`"
  >
    <!-- User Message: Rounded Bubble -->
    <div
      v-if="isUser"
      class="flex flex-col items-end gap-2 pl-10 transition-all duration-300"
      :class="props.forking ? 'opacity-85' : ''"
      role="group"
      aria-label="用户发送的内容"
    >
      <div
        v-if="!props.editing"
        class="bg-ui-surface text-ui-text px-4 py-2.5 rounded-[20px] text-[14px] leading-relaxed border border-ui-border/50 transition-all duration-300 prose"
        :class="props.forking ? 'border-ui-accent/45 scale-[0.99] -translate-y-0.5 shadow-[0_0_0_1px_rgba(37,99,235,0.06)]' : ''"
        data-testid="user-message-bubble"
      >
        <ThemeProvider :theme="incremarkTheme">
          <IncremarkContent :content="props.content" :is-finished="true" :components="incremarkComponents" />
        </ThemeProvider>
      </div>
      <div
        v-else
        class="w-full rounded-2xl border border-ui-accent/40 bg-ui-surface px-3 py-3 transition-all duration-300"
        :class="props.forking ? 'shadow-[0_0_0_1px_rgba(37,99,235,0.10)] -translate-y-0.5' : ''"
        data-testid="user-inline-editor"
      >
        <textarea
          ref="inlineTextarea"
          class="w-full min-h-[54px] resize-y rounded-xl border border-ui-border bg-ui-bg px-3 py-2 text-[14px] leading-relaxed text-ui-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          data-testid="user-inline-editor-input"
          :value="props.editDraft ?? props.content"
          aria-label="编辑用户消息"
          :disabled="props.editSubmitting"
          @input="handleEditChange"
          @keydown="handleEditKeydown"
        />
        <div class="mt-2 flex items-center justify-end gap-1.5">
          <button
            type="button"
            class="p-1.5 hover:bg-ui-bg rounded-md text-ui-text-muted hover:text-ui-text transition-all disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            aria-label="取消编辑"
            title="取消编辑"
            :disabled="props.editSubmitting"
            @click="handleEditCancel"
          >
            <X :size="14" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="p-1.5 hover:bg-ui-bg rounded-md text-ui-text-muted hover:text-ui-text transition-all disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            aria-label="提交编辑并重跑"
            title="提交编辑并重跑"
            :disabled="props.editSubmitting || !String((props.editDraft ?? props.content ?? '')).trim()"
            @click="handleEditSubmit"
          >
            <Loader2 v-if="props.editSubmitting" :size="14" class="animate-spin text-ui-accent" aria-hidden="true" />
            <Check v-else :size="14" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        v-if="props.forking"
        class="flex items-center gap-1.5 text-ui-accent animate-in fade-in slide-in-from-bottom-1 duration-200"
        data-testid="user-forking-indicator"
        role="status"
        aria-live="polite"
        aria-label="分叉重跑进行中"
      >
        <GitBranch :size="12" class="animate-pulse" aria-hidden="true" />
        <Loader2 :size="12" class="animate-spin" aria-hidden="true" />
      </div>
      <div v-if="props.showEditAction" class="flex items-center">
        <button
          type="button"
          class="p-1.5 hover:bg-ui-surface rounded-md text-ui-text-muted hover:text-ui-text transition-all disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          aria-label="编辑并重跑"
          title="编辑并重跑"
          :data-entry-id="props.entryId"
          data-testid="user-edit-trigger"
          :disabled="props.editDisabled || props.editing || props.editSubmitting || props.forking"
          @click="handleEdit"
        >
          <Pencil :size="14" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- System Message -->
    <div
      v-else-if="isSystem"
      class="flex flex-col gap-2 pr-2"
      role="group"
      aria-label="系统消息"
      data-testid="system-message"
    >
      <div class="rounded-lg border border-ui-border bg-ui-surface/60 px-3 py-2.5">
        <div class="flex items-center gap-2">
          <Sparkles :size="12" class="text-ui-accent" aria-hidden="true" />
          <span class="text-[12px] font-semibold text-ui-text">
            {{ isSummarySystemMessage ? "历史摘要（压缩上下文）" : "系统提示" }}
          </span>
        </div>

        <div v-if="!isSummarySystemMessage" class="mt-2 prose max-w-none text-[13px] leading-relaxed text-ui-text">
          <ThemeProvider :theme="incremarkTheme">
            <IncremarkContent :content="normalizedSystemContent" :is-finished="true" :components="incremarkComponents" />
          </ThemeProvider>
        </div>

        <button
          v-else
          type="button"
          class="mt-2 flex w-fit items-center gap-2 py-1 text-[11px] font-bold text-ui-accent cursor-pointer select-none hover:opacity-80 transition-opacity rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :aria-expanded="showSystemSummary"
          @click="toggleSystemSummary"
        >
          <span class="uppercase tracking-wider">{{ showSystemSummary ? "隐藏摘要" : "查看摘要" }}</span>
          <ChevronUp v-if="showSystemSummary" :size="12" aria-hidden="true" />
          <ChevronDown v-else :size="12" aria-hidden="true" />
        </button>
      </div>

      <div
        v-if="isSummarySystemMessage && showSystemSummary"
        class="animate-in slide-in-from-top-1 duration-200"
        role="region"
        aria-label="历史摘要详情"
      >
        <div class="prose max-w-none rounded-md border border-ui-border bg-ui-bg px-3 py-2.5 text-[13px] leading-relaxed text-ui-text">
          <ThemeProvider :theme="incremarkTheme">
            <IncremarkContent :content="normalizedSystemContent" :is-finished="true" :components="incremarkComponents" />
          </ThemeProvider>
        </div>
      </div>
    </div>

    <!-- Assistant Message: Pure Layout -->
    <div 
      v-else-if="isAssistantLike" 
      class="flex flex-col gap-3 pr-2 group" 
      :class="(props.retrying || props.forking) ? 'opacity-40 select-none' : ''"
      role="group"
      :aria-label="isAssistantStreaming ? '助手正在生成回复' : '助手回复的内容'"
      :data-testid="isAssistantStreaming ? 'assistant-streaming-message' : undefined"
    >
      <!-- AI Content -->
      <div
        class="prose max-w-none text-[14px] text-ui-text font-normal focus:outline-none"
        tabindex="0"
      >
        <div
          v-if="isStreamingPlainText"
          class="whitespace-pre-wrap break-all font-mono text-[13px] leading-relaxed"
        >
          {{ props.content }}
        </div>
        <ThemeProvider v-else :theme="incremarkTheme">
          <IncremarkContent :content="props.content" :is-finished="isFinished" :components="incremarkComponents" />
        </ThemeProvider>
      </div>

      <div
        v-if="isAssistantStreaming"
        class="inline-flex items-center text-[12px] font-mono text-ui-text-muted"
        role="status"
        aria-live="polite"
        data-testid="assistant-streaming-spinner"
      >
        <span v-if="!hasAssistantContent" aria-label="等待模型响应">等待模型响应</span>
        <span v-else class="streaming-ellipsis" aria-label="正在生成">...</span>
      </div>

      <!-- Action Bar: Copy + Retry + Fork -->
      <div
        v-if="isAssistant && (props.showCopyAction || props.showRetryAction || props.showForkAction)"
        class="flex items-center gap-1 transition-opacity"
        :class="(props.retrying || props.forking) ? 'opacity-100' : 'opacity-70 sm:opacity-0 sm:group-hover:opacity-100'"
        role="toolbar"
        aria-label="消息操作"
      >
        <button
          v-if="props.showCopyAction"
          type="button"
          class="p-1.5 hover:bg-ui-surface rounded-md text-ui-text-muted hover:text-ui-text transition-all disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :aria-label="props.copied ? '已复制' : '复制内容'"
          :title="props.copied ? '已复制' : '复制内容'"
          :disabled="props.copyDisabled || props.retrying || props.forking"
          @click="handleCopy"
        >
          <Check v-if="props.copied" :size="14" class="text-green-600" aria-hidden="true" />
          <Copy v-else :size="14" aria-hidden="true" />
        </button>

        <button
          v-if="props.showRetryAction"
          type="button"
          class="p-1.5 hover:bg-ui-surface rounded-md text-ui-text-muted hover:text-ui-text transition-all disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          aria-label="重新回答"
          title="重新回答"
          :data-entry-id="props.entryId"
          :disabled="props.retryDisabled || props.retrying || props.forking"
          @click="handleRegenerate"
        >
          <RotateCcw :size="14" :class="props.retrying ? 'animate-spin text-ui-accent' : ''" aria-hidden="true" />
        </button>

        <button
          v-if="props.showForkAction"
          type="button"
          class="p-1.5 hover:bg-ui-surface rounded-md text-ui-text-muted hover:text-ui-text transition-all disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          aria-label="在新对话中分叉"
          title="在新对话中分叉"
          :data-entry-id="props.entryId"
          :disabled="props.forkDisabled || props.retrying || props.forking"
          @click="handleFork"
        >
          <GitBranch :size="14" :class="props.forking ? 'animate-pulse text-ui-accent' : ''" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- Tool Pending Placeholder -->
    <div
      v-else-if="isToolPending"
      class="flex flex-col pr-2 transition-all duration-200 ease-out"
      :class="props.toolPendingLeaving ? 'opacity-0 -translate-y-1 pointer-events-none' : 'opacity-100 translate-y-0'"
      role="status"
      aria-live="polite"
      aria-label="工具执行中"
      data-testid="tool-running-placeholder"
      :data-tool-action="props.toolPendingAction || props.toolName || ''"
    >
      <div class="tool-running-pill rounded-md px-2.5 py-2" :class="pendingToneClass">
        <div class="flex items-center gap-2 min-w-0">
          <div class="h-5 w-5 shrink-0 rounded-md bg-ui-bg/85 text-ui-text-muted flex items-center justify-center">
            <Loader2
              v-if="props.toolPendingStatus !== 'done' && props.toolPendingStatus !== 'failed'"
              :size="12"
              class="animate-spin"
              aria-hidden="true"
            />
            <Check
              v-else-if="props.toolPendingStatus === 'done'"
              :size="12"
              aria-hidden="true"
            />
            <X
              v-else
              :size="12"
              aria-hidden="true"
            />
          </div>
          <p
            class="min-w-0 flex-1 truncate text-[12px] font-semibold leading-snug"
            :class="pendingToneTextClass"
            :title="props.toolPendingHeadline || pendingCompactLine"
          >
            {{ props.toolPendingHeadline || pendingCompactLine }}
          </p>
        </div>
        <p
          v-if="pendingPreviewLine"
          class="mt-1.5 text-[11px] leading-snug text-ui-text-muted break-all pl-7"
        >
          {{ pendingPreviewLine }}
        </p>
        <div
          v-if="hasPendingDetails"
          class="mt-1 flex items-center pl-7"
        >
          <button
            type="button"
            class="rounded-sm p-1 text-ui-text-muted transition-colors hover:bg-ui-bg/70 hover:text-ui-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            :aria-label="pendingDetailsToggleLabel"
            :title="pendingDetailsToggleLabel"
            :aria-expanded="pendingDetailsExpanded"
            @click="togglePendingDetails"
          >
            <ChevronUp v-if="pendingDetailsExpanded" :size="12" aria-hidden="true" />
            <ChevronDown v-else :size="12" aria-hidden="true" />
          </button>
        </div>
        <div
          v-if="pendingDetailsExpanded && currentPendingStepItem"
          ref="pendingActivityViewport"
          class="tool-activity-viewport mt-2.5 max-h-40 overflow-y-auto rounded-md bg-ui-bg/70 px-2 py-1.5 font-mono text-[11px] leading-snug"
          role="log"
          aria-live="polite"
          @scroll="handlePendingActivityScroll"
        >
          <div
            class="py-1"
          >
            <p
              v-if="pendingRawDetail"
              class="pl-2 break-all whitespace-pre-wrap text-ui-text-muted/90"
            >
              {{ pendingRawDetail }}
            </p>
            <div v-if="denoisedPendingLogs.length" class="pl-2">
              <p
                v-for="(log, logIdx) in denoisedPendingLogs"
                :key="`${currentPendingStepItem.step}-log-${logIdx}-${log}`"
                class="break-all whitespace-pre-wrap text-ui-text-muted"
              >
                <span class="text-ui-text-muted/70">› </span>{{ log }}
              </p>
            </div>
            <p
              v-else
              class="pl-2 text-ui-text-muted/80"
            >
              等待输出…
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Tool/Thinking Message: Collapsible (No buttons) -->
    <div v-else-if="isTool" class="flex flex-col group/tool" role="group" aria-label="工具调用结果">
      <div class="rounded-md px-2 py-1.5" :class="toolToneClass">
        <div class="flex items-center gap-1.5 min-w-0">
          <div class="h-4.5 w-4.5 shrink-0 rounded-sm bg-ui-bg/80 text-ui-text-muted flex items-center justify-center">
            <component :is="toolIcon" :size="12" aria-hidden="true" />
          </div>
          <p
            class="min-w-0 flex-1 truncate text-[11px] font-semibold leading-snug"
            :class="toolToneTextClass"
            :title="toolRender.subtitle ? `${toolRender.title} · ${toolRender.subtitle}` : toolRender.title"
          >
            {{ toolCompactLine }}
          </p>
          <button
            type="button"
            class="shrink-0 rounded-sm p-1 text-ui-text-muted transition-opacity hover:bg-ui-bg/60 hover:text-ui-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-text-muted"
            :class="showThinking ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100'"
            :aria-label="toolToggleAriaLabel"
            :title="toolToggleAriaLabel"
            :aria-expanded="showThinking"
            aria-controls="thinking-content"
            @click="toggleThinking"
          >
            <ChevronUp v-if="showThinking" :size="12" aria-hidden="true" />
            <ChevronDown v-else :size="12" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        v-if="showThinking"
        id="thinking-content"
        class="animate-in slide-in-from-top-1 duration-200"
        role="region"
        aria-label="工具详细数据"
      >
        <pre class="text-[11px] bg-ui-bg/70 p-2 rounded-md overflow-x-auto my-1 font-mono text-ui-text-muted"><code>{{ toolTextContent }}</code></pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(pre) {
  max-width: 100%;
  overflow-x: auto;
}
/* Action bar appears on message hover */
.group:hover .transition-opacity {
  opacity: 1;
}

.tool-running-pill {
  background: rgba(15, 23, 42, 0.04);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

@media (prefers-color-scheme: dark) {
  .tool-running-pill {
    background: rgba(148, 163, 184, 0.12);
  }
}

.tool-activity-viewport {
  scrollbar-gutter: stable both-edges;
}

.streaming-ellipsis {
  display: inline-block;
  width: 3ch;
  overflow: hidden;
  white-space: nowrap;
  letter-spacing: 0.04em;
  animation: streaming-ellipsis 1s steps(4, end) infinite;
}

@keyframes streaming-ellipsis {
  0% {
    width: 0ch;
    opacity: 0.35;
  }
  35% {
    width: 1ch;
    opacity: 0.62;
  }
  65% {
    width: 2ch;
    opacity: 0.82;
  }
  85% {
    width: 3ch;
    opacity: 1;
  }
  100% {
    width: 3ch;
    opacity: 0.45;
  }
}

@media (prefers-reduced-motion: reduce) {
  .animate-spin {
    animation: none !important;
  }

  .streaming-ellipsis {
    animation: none;
    width: 3ch;
    opacity: 0.8;
  }
}
</style>
