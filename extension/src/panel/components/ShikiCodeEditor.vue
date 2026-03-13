<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { highlightCodeToHtml, type ShikiTheme } from "../utils/shiki-highlighter";
import { useDark } from "@vueuse/core";

const props = defineProps<{
  modelValue: string;
  language: string;
  ariaLabel?: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const isDark = useDark();
const shikiTheme = computed<ShikiTheme>(() => (isDark.value ? "min-dark" : "github-light"));

const highlightedHtml = ref("");
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const preRef = ref<HTMLPreElement | null>(null);

async function updateHighlight(code: string) {
  try {
    highlightedHtml.value = await highlightCodeToHtml(code, props.language, shikiTheme.value);
  } catch {
    highlightedHtml.value = "";
  }
}

watch(
  () => [props.modelValue, props.language, shikiTheme.value] as const,
  ([code]) => {
    updateHighlight(code);
  },
  { immediate: true }
);

function onInput(event: Event) {
  const target = event.target as HTMLTextAreaElement;
  emit("update:modelValue", target.value);
}

function syncScroll() {
  if (textareaRef.value && preRef.value) {
    preRef.value.scrollTop = textareaRef.value.scrollTop;
    preRef.value.scrollLeft = textareaRef.value.scrollLeft;
  }
}

function handleTab(event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  event.preventDefault();
  const textarea = textareaRef.value;
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const indent = "  ";
  const next = value.substring(0, start) + indent + value.substring(end);
  emit("update:modelValue", next);
  nextTick(() => {
    textarea.selectionStart = textarea.selectionEnd = start + indent.length;
  });
}
</script>

<template>
  <div class="shiki-editor">
    <div
      ref="preRef"
      class="shiki-highlight"
      v-html="highlightedHtml"
      aria-hidden="true"
    />
    <textarea
      ref="textareaRef"
      :value="modelValue"
      class="shiki-textarea"
      :aria-label="ariaLabel || 'Code editor'"
      :placeholder="placeholder"
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      @input="onInput"
      @scroll="syncScroll"
      @keydown="handleTab"
    />
  </div>
</template>

<style scoped>
.shiki-editor {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.shiki-highlight,
.shiki-textarea {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 12px;
  font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
  overflow: auto;
  word-wrap: normal;
  border: none;
  outline: none;
}

.shiki-highlight {
  pointer-events: none;
  z-index: 0;
}

.shiki-highlight :deep(pre) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  tab-size: inherit;
  white-space: pre;
}

.shiki-highlight :deep(code) {
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  tab-size: inherit;
  white-space: pre;
}

.shiki-textarea {
  z-index: 1;
  color: transparent;
  caret-color: var(--text);
  background: transparent;
  resize: none;
  -webkit-text-fill-color: transparent;
}

.shiki-textarea::placeholder {
  -webkit-text-fill-color: var(--text-muted);
  color: var(--text-muted);
}
</style>
