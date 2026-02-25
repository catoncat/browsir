<script setup lang="ts">
import { computed } from "vue";
import { IncremarkContent, ThemeProvider } from "@incremark/vue";
import IncremarkCodeBlock from "./IncremarkCodeBlock.vue";
import { usePanelDarkMode } from "../utils/use-panel-dark-mode";

const props = defineProps<{
  content: string;
  active: boolean;
}>();

const isDark = usePanelDarkMode();
const incremarkTheme = computed(() => (isDark.value ? "dark" : "default"));
const hasContent = computed(() => String(props.content || "").trim().length > 0);

const incremarkComponents = {
  code: IncremarkCodeBlock
};
</script>

<template>
  <div
    class="flex flex-col gap-2 pr-2"
    role="listitem"
    aria-live="polite"
    aria-label="助手流式草稿"
    data-testid="assistant-streaming-message"
  >
    <div
      class="prose max-w-none text-[14px] text-ui-text font-normal focus:outline-none"
      tabindex="0"
    >
      <ThemeProvider :theme="incremarkTheme">
        <IncremarkContent :content="props.content" :is-finished="!props.active" :components="incremarkComponents" />
      </ThemeProvider>
    </div>

    <div
      v-if="props.active"
      class="inline-flex items-center text-[12px] font-mono text-ui-text-muted"
      role="status"
      aria-live="polite"
      data-testid="assistant-streaming-spinner"
    >
      <span v-if="!hasContent" aria-label="等待模型响应">等待模型响应</span>
      <span v-else class="streaming-ellipsis" aria-label="正在生成">...</span>
    </div>
  </div>
</template>

<style scoped>
.streaming-ellipsis {
  display: inline-block;
  overflow: hidden;
  width: 1.7em;
  vertical-align: bottom;
  animation: streaming-ellipsis 1s steps(4, end) infinite;
}

@keyframes streaming-ellipsis {
  0% {
    width: 0;
  }

  100% {
    width: 1.7em;
  }
}

@media (prefers-reduced-motion: reduce) {
  .streaming-ellipsis {
    animation: none;
    width: auto;
  }
}
</style>
