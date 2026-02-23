<script setup lang="ts">
import { ref, computed } from "vue";
import {
  Sparkles,
  ChevronDown,
  ChevronUp,
  ThumbsUp,
  ThumbsDown,
  RotateCcw,
  Copy,
  Check,
  MoreVertical
} from "lucide-vue-next";
import { renderMarkdown } from "../utils/markdown";

const props = defineProps<{
  role: string;
  content: string;
  entryId: string;
  copied?: boolean;
  copyDisabled?: boolean;
  regenerateDisabled?: boolean;
  showCopyAction?: boolean;
  showRegenerateAction?: boolean;
}>();

const emit = defineEmits<{
  (e: "copy", payload: { entryId: string; content: string; role: string }): void;
  (e: "regenerate", payload: { entryId: string }): void;
}>();

const isUser = computed(() => props.role === "user");
const isAssistant = computed(() => props.role === "assistant");
const isTool = computed(() => props.role === "tool");

const showThinking = ref(false);

const htmlContent = computed(() => {
  if (isTool.value) {
    try {
      const data = JSON.parse(props.content);
      return `<pre class="text-[12px] bg-gemini-surface p-3 rounded-xl border border-gemini-border overflow-x-auto my-2"><code>${JSON.stringify(data, null, 2)}</code></pre>`;
    } catch {
      return `<code class="text-[12px] font-mono opacity-60">${props.content}</code>`;
    }
  }
  return renderMarkdown(props.content);
});

function toggleThinking() {
  showThinking.value = !showThinking.value;
}

function handleCopy() {
  emit("copy", { entryId: props.entryId, content: props.content, role: props.role });
}

function handleRegenerate() {
  emit("regenerate", { entryId: props.entryId });
}
</script>

<template>
  <div class="flex flex-col mb-8 animate-in fade-in duration-500">
    <div v-if="isUser" class="flex justify-end pl-12">
      <div
        class="bg-gemini-user-bubble text-gemini-text px-5 py-3 rounded-[24px] text-[15px] leading-relaxed shadow-sm border border-black/[0.02]"
        v-html="htmlContent"
      ></div>
    </div>

    <div v-else-if="isAssistant" class="flex flex-col gap-4 pr-4">
      <div
        class="prose max-w-none text-[15px] text-gemini-text"
        v-html="htmlContent"
      ></div>

      <div class="flex items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
        <button type="button" class="p-2 hover:bg-gemini-surface rounded-full transition-colors" aria-label="赞" title="赞">
          <ThumbsUp :size="16" />
        </button>
        <button type="button" class="p-2 hover:bg-gemini-surface rounded-full transition-colors" aria-label="踩" title="踩">
          <ThumbsDown :size="16" />
        </button>

        <button
          v-if="props.showRegenerateAction"
          type="button"
          class="p-2 hover:bg-gemini-surface rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="重新回答"
          title="重新回答"
          :disabled="props.regenerateDisabled"
          @click="handleRegenerate"
        >
          <RotateCcw :size="16" />
        </button>

        <button
          v-if="props.showCopyAction"
          type="button"
          class="p-2 hover:bg-gemini-surface rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          :aria-label="props.copied ? '已复制' : '复制内容'"
          :title="props.copied ? '已复制' : '复制内容'"
          :disabled="props.copyDisabled"
          @click="handleCopy"
        >
          <Check v-if="props.copied" :size="16" />
          <Copy v-else :size="16" />
        </button>

        <button type="button" class="p-2 hover:bg-gemini-surface rounded-full transition-colors" aria-label="更多" title="更多">
          <MoreVertical :size="16" />
        </button>
      </div>
    </div>

    <div v-else-if="isTool" class="flex flex-col">
      <div
        class="flex items-center gap-2 py-2 text-[13px] font-medium text-blue-600 cursor-pointer select-none"
        @click="toggleThinking"
      >
        <Sparkles :size="14" fill="currentColor" class="text-blue-500" />
        <span>{{ showThinking ? "隐藏思维链" : "显示思维链" }}</span>
        <ChevronUp v-if="showThinking" :size="14" />
        <ChevronDown v-else :size="14" />
      </div>
      <div v-if="showThinking" class="animate-in slide-in-from-top-2 duration-300">
        <div v-html="htmlContent"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(pre) {
  max-width: 100%;
  overflow-x: auto;
}
</style>
