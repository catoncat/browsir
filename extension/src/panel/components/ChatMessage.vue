<script setup lang="ts">
import { ref, computed } from "vue";
import {
  Sparkles,
  ChevronDown,
  ChevronUp,
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
  <div class="flex flex-col mb-6 animate-in fade-in duration-300 group">
    <!-- User Message: Rounded Bubble -->
    <div v-if="isUser" class="flex justify-end pl-10">
      <div
        class="bg-ui-surface text-ui-text px-4 py-2.5 rounded-[20px] text-[14px] leading-relaxed border border-ui-border/50"
        v-html="htmlContent"
      ></div>
    </div>

    <!-- Assistant Message: Pure Layout -->
    <div v-else-if="isAssistant" class="flex flex-col gap-3 pr-2 group" :class="(props.retrying || props.forking) ? 'opacity-40 select-none' : ''">
      <!-- AI Content -->
      <div
        class="prose max-w-none text-[14px] text-ui-text font-normal"
        v-html="htmlContent"
      ></div>

      <!-- Action Bar: Copy + Retry + Fork -->
      <div
        v-if="props.showCopyAction || props.showRetryAction || props.showForkAction"
        class="flex items-center gap-1 transition-opacity"
        :class="(props.retrying || props.forking) ? 'opacity-100' : 'opacity-70 sm:opacity-0 sm:group-hover:opacity-100'"
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
          <Check v-if="props.copied" :size="14" class="text-green-600" />
          <Copy v-else :size="14" />
        </button>

        <button
          v-if="props.showRetryAction"
          type="button"
          class="p-1.5 hover:bg-ui-surface rounded-md text-ui-text-muted hover:text-ui-text transition-all disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          aria-label="重新回答"
          title="重新回答"
          :disabled="props.retryDisabled || props.retrying || props.forking"
          @click="handleRegenerate"
        >
          <RotateCcw :size="14" :class="props.retrying ? 'animate-spin text-ui-accent' : ''" />
        </button>

        <button
          v-if="props.showForkAction"
          type="button"
          class="p-1.5 hover:bg-ui-surface rounded-md text-ui-text-muted hover:text-ui-text transition-all disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          aria-label="在新对话中分叉"
          title="在新对话中分叉"
          :disabled="props.forkDisabled || props.retrying || props.forking"
          @click="handleFork"
        >
          <GitBranch :size="14" :class="props.forking ? 'animate-pulse text-ui-accent' : ''" />
        </button>
      </div>
    </div>

    <!-- Tool/Thinking Message: Collapsible (No buttons) -->
    <div v-else-if="isTool" class="flex flex-col">
      <button
        type="button"
        class="flex w-fit items-center gap-2 py-1.5 text-[12px] font-bold text-ui-accent cursor-pointer select-none hover:opacity-80 transition-opacity rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :aria-expanded="showThinking"
        @click="toggleThinking"
      >
        <Sparkles :size="12" fill="currentColor" />
        <span class="uppercase tracking-wider">{{ showThinking ? "Hide thinking" : "Show thinking" }}</span>
        <ChevronUp v-if="showThinking" :size="12" />
        <ChevronDown v-else :size="12" />
      </button>
      <div v-if="showThinking" class="animate-in slide-in-from-top-1 duration-200">
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
