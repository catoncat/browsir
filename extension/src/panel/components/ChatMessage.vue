<script setup lang="ts">
import { ref, computed } from "vue";
import {
  Sparkles,
  ChevronDown,
  ChevronUp,
  Loader2,
  RotateCcw,
  GitBranch,
  Copy,
  Check
} from "lucide-vue-next";
import { renderMarkdown } from "../utils/markdown";

const props = defineProps<{
  role: string;
  content: string;
  entryId: string;
  busyPlaceholder?: boolean;
  busyMode?: "retry" | "fork";
  busySourceEntryId?: string;
  copied?: boolean;
  retrying?: boolean;
  forking?: boolean;
  copyDisabled?: boolean;
  retryDisabled?: boolean;
  forkDisabled?: boolean;
  showCopyAction?: boolean;
  showRetryAction?: boolean;
  showForkAction?: boolean;
}>();

const emit = defineEmits<{
  (e: "copy", payload: { entryId: string; content: string; role: string }): void;
  (e: "retry", payload: { entryId: string }): void;
  (e: "fork", payload: { entryId: string }): void;
}>();

const isUser = computed(() => props.role === "user");
const isAssistant = computed(() => props.role === "assistant");
const isAssistantPlaceholder = computed(() => props.role === "assistant_placeholder" || props.busyPlaceholder === true);
const isTool = computed(() => props.role === "tool");

const showThinking = ref(false);

const htmlContent = computed(() => renderMarkdown(props.content));
const toolTextContent = computed(() => {
  if (!isTool.value) return "";
  try {
    const data = JSON.parse(props.content);
    return JSON.stringify(data, null, 2);
  } catch {
    return props.content;
  }
});

function toggleThinking() {
  showThinking.value = !showThinking.value;
}

function handleCopy() {
  emit("copy", { entryId: props.entryId, content: props.content, role: props.role });
}

function handleRegenerate() {
  emit("retry", { entryId: props.entryId });
}

function handleFork() {
  emit("fork", { entryId: props.entryId });
}
</script>

<template>
  <div 
    class="flex flex-col mb-6 animate-in fade-in duration-300 group"
    role="listitem"
    :aria-label="`${isUser ? '用户' : (isAssistant || isAssistantPlaceholder) ? '助手' : '工具'}消息: ${props.content.slice(0, 50)}...`"
  >
    <!-- User Message: Rounded Bubble -->
    <div v-if="isUser" class="flex justify-end pl-10" role="group" aria-label="用户发送的内容">
      <div
        class="bg-ui-surface text-ui-text px-4 py-2.5 rounded-[20px] text-[14px] leading-relaxed border border-ui-border/50"
        v-html="htmlContent"
      ></div>
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
      class="flex flex-col gap-2 pr-2"
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

    <!-- Tool/Thinking Message: Collapsible (No buttons) -->
    <div v-else-if="isTool" class="flex flex-col" role="group" aria-label="思考过程与工具调用">
      <button
        type="button"
        class="flex w-fit items-center gap-2 py-1.5 text-[12px] font-bold text-ui-accent cursor-pointer select-none hover:opacity-80 transition-opacity rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :aria-expanded="showThinking"
        aria-controls="thinking-content"
        @click="toggleThinking"
      >
        <Sparkles :size="12" fill="currentColor" aria-hidden="true" />
        <span class="uppercase tracking-wider">{{ showThinking ? "隐藏思考过程" : "显示思考过程" }}</span>
        <ChevronUp v-if="showThinking" :size="12" aria-hidden="true" />
        <ChevronDown v-else :size="12" aria-hidden="true" />
      </button>
      <div v-if="showThinking" id="thinking-content" class="animate-in slide-in-from-top-1 duration-200" role="region" aria-label="详细数据">
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
</style>
