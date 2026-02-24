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
import { renderMarkdown } from "../utils/markdown";
import { resolveToolRender } from "../utils/tool-renderers";

const props = defineProps<{
  role: string;
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
  toolPending?: boolean;
  toolPendingAction?: string;
  toolPendingDetail?: string;
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
const isAssistant = computed(() => props.role === "assistant");
const isAssistantPlaceholder = computed(() => props.role === "assistant_placeholder" || props.busyPlaceholder === true);
const isTool = computed(() => props.role === "tool");
const isToolPending = computed(() => props.role === "tool_pending" || props.toolPending === true);

const showThinking = ref(false);
const inlineTextarea = ref<HTMLTextAreaElement | null>(null);

const htmlContent = computed(() => renderMarkdown(props.content));
const toolRender = computed(() =>
  resolveToolRender({
    content: props.content,
    toolName: props.toolName,
    toolCallId: props.toolCallId
  })
);
const toolTextContent = computed(() => {
  if (!isTool.value) return "";
  return toolRender.value.detail;
});
const messageAriaPreview = computed(() => {
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

function toggleThinking() {
  showThinking.value = !showThinking.value;
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
</script>

<template>
  <div 
    class="flex flex-col mb-6 animate-in fade-in duration-300 group"
    role="listitem"
    :aria-label="`${isUser ? '用户' : (isAssistant || isAssistantPlaceholder) ? '助手' : '工具'}消息: ${messageAriaPreview}...`"
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
        class="bg-ui-surface text-ui-text px-4 py-2.5 rounded-[20px] text-[14px] leading-relaxed border border-ui-border/50 transition-all duration-300"
        :class="props.forking ? 'border-ui-accent/45 scale-[0.99] -translate-y-0.5 shadow-[0_0_0_1px_rgba(37,99,235,0.06)]' : ''"
        data-testid="user-message-bubble"
        v-html="htmlContent"
      ></div>
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

    <!-- Assistant Message: Pure Layout -->
    <div 
      v-else-if="isAssistant" 
      class="flex flex-col gap-3 pr-2 group" 
      :class="(props.retrying || props.forking) ? 'opacity-40 select-none' : ''"
      role="group"
      aria-label="助手回复的内容"
    >
      <!-- AI Content -->
      <div
        class="prose max-w-none text-[14px] text-ui-text font-normal focus:outline-none"
        v-html="htmlContent"
        tabindex="0"
      ></div>

      <!-- Action Bar: Copy + Retry + Fork -->
      <div
        v-if="props.showCopyAction || props.showRetryAction || props.showForkAction"
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
      class="flex flex-col pr-2"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="工具执行中"
      data-testid="tool-running-placeholder"
      :data-tool-action="props.toolPendingAction || props.toolName || ''"
    >
      <div class="tool-running-pill rounded-lg border border-ui-accent/25 px-3 py-2.5">
        <div class="flex items-center gap-2">
          <Loader2 :size="13" class="animate-spin text-ui-accent" aria-hidden="true" />
          <span class="text-[12px] font-semibold text-ui-accent">
            正在执行：{{ props.toolPendingAction || props.toolName || "工具调用" }}
          </span>
        </div>
        <p
          v-if="props.toolPendingDetail"
          class="mt-1.5 text-[11px] leading-snug text-ui-text-muted break-all pl-5"
        >
          {{ props.toolPendingDetail }}
        </p>
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
  background: linear-gradient(110deg, rgba(37, 99, 235, 0.10) 0%, rgba(37, 99, 235, 0.04) 35%, rgba(37, 99, 235, 0.16) 50%, rgba(37, 99, 235, 0.04) 65%, rgba(37, 99, 235, 0.10) 100%);
  background-size: 220% 100%;
  animation: tool-shimmer 1.45s linear infinite;
}

@keyframes tool-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -20% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tool-running-pill {
    animation: none;
  }
}
</style>
