<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  title: string;
  ariaLabel: string;
}>();

const rootEl = ref<HTMLElement | null>(null);

defineExpose({
  getRootEl: () => rootEl.value
});
</script>

<template>
  <div
    ref="rootEl"
    class="absolute bottom-[calc(100%+8px)] left-0 right-0 z-[100] bg-ui-bg border border-ui-border rounded-xl shadow-[0_12px_40px_-12px_rgba(0,0,0,0.3)] overflow-hidden animate-in slide-in-from-bottom-2 duration-200"
    role="listbox"
    :aria-label="props.ariaLabel"
  >
    <div class="px-3 py-1.5 bg-ui-surface border-b border-ui-border flex items-center justify-between">
      <div class="flex items-center gap-2 text-[10px] font-bold text-ui-text-muted uppercase tracking-widest">
        <slot name="icon" />
        <span>{{ props.title }}</span>
      </div>
      <slot name="headerRight" />
    </div>
    <slot />
    <slot name="footer" />
  </div>
</template>
