<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { usePreferredDark } from "@vueuse/core";
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
  busyPlaceholder?: boolean;
  busyMode?: "retry" | "fork";
  busySourceEntryId?: string;
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
const isAssistantPlaceholder = computed(() => props.role === "assistant_placeholder" || props.busyPlaceholder === true);
const isTool = computed(() => props.role === "tool");
const isToolPending = computed(() => props.role === "tool_pending" || props.toolPending === true);

const incremarkComponents = {
  code: IncremarkCodeBlock
};

const isDark = usePreferredDark();
const incremarkTheme = computed(() => isDark.value ? "dark" : "default");

const isFinished = computed(() => props.role !== "assistant_streaming");

const showThinking = ref(false);
const showSystemSummary = ref(false);
const inlineTextarea = ref<HTMLTextAreaElement | null>(null);
const pendingActivityViewport = ref<HTMLElement | null>(null);
const pendingCardExpanded = ref(false);
const pendingCardStickToBottom = ref(true);
const STEP_LOG_PREVIEW_LINES = 4;

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
const toolToneClass = computed(() => {
  if (toolRender.value.tone === "error") return "border-rose-300/80 bg-rose-50/60";
  if (toolRender.value.tone === "success") return "border-emerald-300/70 bg-emerald-50/40";
  return "border-ui-border bg-ui-surface/60";
});
const toolToneTextClass = computed(() => {
  if (toolRender.value.tone === "error") return "text-rose-700";
  if (toolRender.value.tone === "success") return "text-emerald-700";
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
const pendingTotalLogLines = computed(() =>
  pendingStepItems.value.reduce((total, item) => total + item.logs.length, 0)
);
const pendingLineCount = computed(() =>
  pendingStepItems.value.reduce((total, item) => total + 1 + item.logs.length, 0)
);
const pendingCardExpandable = computed(() => pendingLineCount.value > 10);

function visibleLogsForStep(logs: string[]) {
  if (pendingCardExpanded.value) return logs;
  if (logs.length <= STEP_LOG_PREVIEW_LINES) return logs;
  return logs.slice(-STEP_LOG_PREVIEW_LINES);
}

function toggleThinking() {
  showThinking.value = !showThinking.value;
}

function toggleSystemSummary() {
  showSystemSummary.value = !showSystemSummary.value;
}

function togglePendingCardExpand() {
  pendingCardExpanded.value = !pendingCardExpanded.value;
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
    pendingCardExpanded.value = false;
    pendingCardStickToBottom.value = true;
  }
);

watch(
  () => pendingLineCount.value,
  async () => {
    await nextTick();
    syncPendingActivityScroll();
  }
);

watch(
  () => pendingCardExpanded.value,
  async () => {
    await nextTick();
    syncPendingActivityScroll(true);
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
    class="flex flex-col mb-6 animate-in fade-in duration-300 group"
    role="listitem"
    :aria-label="`${isUser ? '用户' : isSystem ? '系统' : (isAssistantLike || isAssistantPlaceholder) ? '助手' : '工具'}消息: ${messageAriaPreview}...`"
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
        <span class="streaming-ellipsis" aria-label="正在思考">...</span>
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

    <!-- Regenerate Placeholder -->
    <div
      v-else-if="isAssistantPlaceholder"
      class="flex flex-col gap-2 pr-2 transition-all duration-200"
      :class="props.busyMode === 'fork' ? 'translate-y-0.5 opacity-95' : ''"
      data-testid="regenerate-placeholder"
      role="status"
      aria-live="polite"
      aria-busy="true"
      :data-mode="props.busyMode || 'retry'"
      :data-source-entry-id="props.busySourceEntryId || ''"
    >
      <div class="flex items-center gap-2 text-ui-accent">
        <Loader2 :size="14" class="animate-spin" data-testid="regenerate-spinner" />
        <span class="text-[13px] font-semibold animate-pulse">正在重新生成回复…</span>
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
      <div class="tool-running-pill rounded-lg border border-ui-accent/25 px-3 py-2.5">
        <div class="flex items-center gap-2">
          <Loader2 v-if="props.toolPendingStatus !== 'done' && props.toolPendingStatus !== 'failed'" :size="13" class="animate-spin text-ui-accent" aria-hidden="true" />
          <Check v-else-if="props.toolPendingStatus === 'done'" :size="13" class="text-emerald-600" aria-hidden="true" />
          <X v-else :size="13" class="text-rose-600" aria-hidden="true" />
          <span
            class="text-[12px] font-semibold"
            :class="props.toolPendingStatus === 'failed'
              ? 'text-rose-700'
              : props.toolPendingStatus === 'done'
                ? 'text-emerald-700'
                : 'text-ui-accent'"
          >
            {{ props.toolPendingHeadline || `正在执行：${props.toolPendingAction || props.toolName || "工具调用"}` }}
          </span>
        </div>
        <p
          v-if="props.toolPendingDetail"
          class="mt-1.5 text-[11px] leading-snug text-ui-text-muted break-all pl-5"
        >
          {{ props.toolPendingDetail }}
        </p>
        <div
          v-if="pendingStepItems.length"
          ref="pendingActivityViewport"
          class="tool-activity-viewport mt-2.5 overflow-y-auto border-t border-ui-accent/20 pt-2 font-mono text-[11px] leading-snug"
          :class="pendingCardExpanded ? 'max-h-72' : 'max-h-44'"
          @scroll="handlePendingActivityScroll"
        >
          <div
            v-for="(item, idx) in pendingStepItems"
            :key="item.step"
            class="py-1.5"
            :class="idx > 0 ? 'border-t border-ui-accent/10' : ''"
          >
            <p
              class="break-all whitespace-pre-wrap"
              :class="item.status === 'failed' ? 'text-rose-700' : item.status === 'done' ? 'text-ui-text' : 'text-ui-text'"
            >
              {{ item.line }}
            </p>
            <div v-if="item.logs.length" class="mt-1 pl-3">
              <p
                v-for="(log, logIdx) in visibleLogsForStep(item.logs)"
                :key="`${item.step}-log-${logIdx}-${log}`"
                class="break-all whitespace-pre-wrap text-ui-text-muted"
              >
                <span class="text-ui-accent/80">› </span>{{ log }}
              </p>
              <p
                v-if="!pendingCardExpanded && item.logs.length > STEP_LOG_PREVIEW_LINES"
                class="text-[10px] text-ui-text-muted/90"
              >
                … 还有 {{ item.logs.length - STEP_LOG_PREVIEW_LINES }} 行输出
              </p>
            </div>
          </div>
        </div>
        <div class="mt-2 flex items-center justify-between text-[10px] text-ui-text-muted">
          <span>{{ pendingStepItems.length }} 步 · 输出 {{ pendingTotalLogLines }} 行</span>
          <button
            v-if="pendingCardExpandable"
            type="button"
            class="rounded px-1.5 py-0.5 font-semibold text-ui-accent hover:bg-ui-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            :aria-label="pendingCardExpanded ? '收起执行卡片' : '展开执行卡片'"
            @click="togglePendingCardExpand"
          >
            {{ pendingCardExpanded ? "收起" : "展开" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Tool/Thinking Message: Collapsible (No buttons) -->
    <div v-else-if="isTool" class="flex flex-col" role="group" aria-label="工具调用结果">
      <div class="rounded-lg border p-2.5" :class="toolToneClass">
        <div class="flex items-start gap-2.5">
          <div class="mt-0.5 h-5 w-5 shrink-0 rounded-md bg-white/70 text-ui-accent flex items-center justify-center border border-ui-border/60">
            <component :is="toolIcon" :size="12" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-[12px] font-semibold leading-snug" :class="toolToneTextClass">{{ toolRender.title }}</p>
            <p v-if="toolRender.subtitle" class="mt-1 text-[11px] leading-snug text-ui-text-muted break-all">{{ toolRender.subtitle }}</p>
          </div>
        </div>
        <button
          type="button"
          class="mt-2 flex w-fit items-center gap-2 py-1 text-[11px] font-bold text-ui-accent cursor-pointer select-none hover:opacity-80 transition-opacity rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :aria-expanded="showThinking"
          aria-controls="thinking-content"
          @click="toggleThinking"
        >
          <span class="uppercase tracking-wider">{{ showThinking ? "隐藏运行详情" : "查看运行详情" }}</span>
          <ChevronUp v-if="showThinking" :size="12" aria-hidden="true" />
          <ChevronDown v-else :size="12" aria-hidden="true" />
        </button>
      </div>
      <div
        v-if="showThinking"
        id="thinking-content"
        class="animate-in slide-in-from-top-1 duration-200"
        role="region"
        aria-label="工具详细数据"
      >
        <pre class="text-[11px] bg-ui-surface p-2.5 rounded-md border border-ui-border overflow-x-auto my-1.5 font-mono"><code>{{ toolTextContent }}</code></pre>
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
  position: relative;
  overflow: hidden;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  background: linear-gradient(155deg, rgba(30, 41, 59, 0.08) 0%, rgba(37, 99, 235, 0.08) 100%);
  box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.12);
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
