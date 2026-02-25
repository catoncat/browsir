<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Check, Copy } from "lucide-vue-next";
import type { Code } from "mdast";
import { highlightCodeToHtml, normalizeCodeLanguage, type ShikiTheme } from "../utils/shiki-highlighter";
import { usePanelDarkMode } from "../utils/use-panel-dark-mode";

const props = defineProps<{
  node: Code;
}>();

const isDark = usePanelDarkMode();
const code = computed(() => String(props.node?.value || ""));
const languageLabel = computed(() => normalizeCodeLanguage(props.node?.lang));
const shikiTheme = computed<ShikiTheme>(() => (isDark.value ? "min-dark" : "github-light"));

const highlightedHtml = ref("");
const copied = ref(false);

let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
let renderVersion = 0;

watch(
  () => [code.value, props.node?.lang, shikiTheme.value] as const,
  async ([sourceCode, lang, theme]) => {
    const currentVersion = ++renderVersion;
    if (!sourceCode) {
      highlightedHtml.value = "";
      return;
    }
    try {
      const html = await highlightCodeToHtml(sourceCode, lang, theme);
      if (currentVersion !== renderVersion) return;
      highlightedHtml.value = html;
    } catch (error) {
      if (currentVersion !== renderVersion) return;
      highlightedHtml.value = "";
      console.warn("Shiki highlight failed, fallback to plain code.", error);
    }
  },
  { immediate: true }
);

async function copyCode() {
  if (!navigator?.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(code.value);
    copied.value = true;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // ignore copy failures
  }
}

onBeforeUnmount(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer);
});
</script>

<template>
  <div class="incremark-code">
    <div class="code-header">
      <span class="language">{{ languageLabel }}</span>
      <button
        type="button"
        class="code-btn"
        :aria-label="copied ? '已复制' : '复制代码'"
        :title="copied ? '已复制' : '复制代码'"
        @click="copyCode"
      >
        <Check v-if="copied" :size="14" aria-hidden="true" />
        <Copy v-else :size="14" aria-hidden="true" />
      </button>
    </div>
    <div class="code-content">
      <div
        v-if="highlightedHtml"
        class="shiki-wrapper"
        v-html="highlightedHtml"
      />
      <pre v-else class="code-fallback"><code>{{ code }}</code></pre>
    </div>
  </div>
</template>
