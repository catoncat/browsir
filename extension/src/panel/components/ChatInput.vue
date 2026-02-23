<script setup lang="ts">
import { ref, watch, computed, onMounted, nextTick } from "vue";
import { Send, Square, Plus, Sparkles, ChevronDown, X, Globe, Search, Check } from "lucide-vue-next";
import { useTextareaAutosize, onClickOutside } from "@vueuse/core";

interface TabItem {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

const props = defineProps<{
  disabled?: boolean;
  isRunning?: boolean;
  modelValue: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "send", payload: { text: string; tabIds: number[] }): void;
  (e: "stop"): void;
}>();

const { textarea, input: text } = useTextareaAutosize();
const selectedTabs = ref<TabItem[]>([]);
const availableTabs = ref<TabItem[]>([]);
const showMentionList = ref(false);
const mentionFilter = ref("");
const focusedIndex = ref(0);
const mentionContainer = ref<HTMLElement | null>(null);
const listScrollContainer = ref<HTMLElement | null>(null);

onClickOutside(mentionContainer, () => {
  showMentionList.value = false;
});

async function refreshTabs() {
  const tabs = await chrome.tabs.query({});
  availableTabs.value = tabs
    .filter(t => t.id && t.title)
    .map(t => ({
      id: t.id!,
      title: t.title!,
      url: t.url || "",
      favIconUrl: t.favIconUrl
    }));
}

const filteredTabs = computed(() => {
  const q = mentionFilter.value.toLowerCase();
  return availableTabs.value.filter(t => 
    t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)
  );
});

watch(text, (newVal) => {
  emit("update:modelValue", newVal);
  const lastChar = newVal.slice(-1);
  if (lastChar === "@") {
    void refreshTabs();
    showMentionList.value = true;
    mentionFilter.value = "";
    focusedIndex.value = 0;
  } else if (showMentionList.value) {
    const match = /@(\w*)$/.exec(newVal);
    if (match) {
      mentionFilter.value = match[1];
      focusedIndex.value = 0; // Reset index on search
    } else {
      showMentionList.value = false;
    }
  }
});

function isTabSelected(id: number) {
  return selectedTabs.value.some(t => t.id === id);
}

function toggleTabSelection(tab: TabItem) {
  const idx = selectedTabs.value.findIndex(t => t.id === tab.id);
  if (idx > -1) {
    selectedTabs.value.splice(idx, 1);
  } else {
    selectedTabs.value.push(tab);
  }
}

function confirmSelection() {
  // If no tabs were manually toggled but user hits enter on one, select it
  if (selectedTabs.value.length === 0 && filteredTabs.value[focusedIndex.value]) {
    toggleTabSelection(filteredTabs.value[focusedIndex.value]);
  }
  
  // Clean up the @ string from input
  text.value = text.value.replace(/@\w*$/, "");
  showMentionList.value = false;
  textarea.value?.focus();
}

function handleKeydown(e: KeyboardEvent) {
  if (showMentionList.value) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusedIndex.value = (focusedIndex.value + 1) % filteredTabs.value.length;
      scrollToFocused();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusedIndex.value = (focusedIndex.value - 1 + filteredTabs.value.length) % filteredTabs.value.length;
      scrollToFocused();
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirmSelection();
    } else if (e.key === " ") {
      // Space for multi-select toggle
      e.preventDefault();
      const currentTab = filteredTabs.value[focusedIndex.value];
      if (currentTab) toggleTabSelection(currentTab);
    } else if (e.key === "Escape") {
      showMentionList.value = false;
    }
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function scrollToFocused() {
  nextTick(() => {
    const el = document.getElementById(`tab-item-${focusedIndex.value}`);
    if (el && listScrollContainer.value) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

function handleSend() {
  if (text.value.trim().length === 0 || props.disabled || props.isRunning) return;
  emit("send", {
    text: text.value,
    tabIds: selectedTabs.value.map(t => t.id)
  });
  text.value = "";
  // We keep the selected context for the next turn as per Gemini behavior
}
</script>

<template>
  <div class="w-full px-4 pb-4 bg-ui-bg relative">
    <!-- Mention Dropdown (Keyboard Enabled) -->
    <div 
      v-if="showMentionList" 
      ref="mentionContainer"
      class="absolute bottom-[calc(100%-8px)] left-6 right-6 z-50 bg-white dark:bg-[#2b2d2f] border border-ui-border rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2 duration-200"
    >
      <div class="px-4 py-2.5 bg-ui-surface/50 border-b border-ui-border/50 flex items-center justify-between">
        <div class="flex items-center gap-2 text-[11px] font-bold text-ui-text-muted uppercase tracking-wider">
          <Search :size="12" />
          Select Tabs
        </div>
        <div class="text-[10px] text-ui-text-muted opacity-60">
          Space to toggle • Enter to confirm
        </div>
      </div>
      
      <div ref="listScrollContainer" class="max-h-64 overflow-y-auto custom-scrollbar">
        <button 
          v-for="(tab, index) in filteredTabs" 
          :id="`tab-item-${index}`"
          :key="tab.id"
          class="w-full flex items-center gap-3 px-4 py-3 transition-colors text-left border-b border-ui-border/30 last:border-0"
          :class="[
            focusedIndex === index ? 'bg-ui-surface' : '',
            isTabSelected(tab.id) ? 'text-ui-accent' : ''
          ]"
          @mouseenter="focusedIndex = index"
          @click="toggleTabSelection(tab)"
        >
          <div class="relative">
            <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-4 h-4 shrink-0 rounded-sm" />
            <Globe v-else :size="16" class="text-ui-text-muted shrink-0" />
            <div v-if="isTabSelected(tab.id)" class="absolute -top-1 -right-1 bg-ui-accent text-white rounded-full p-0.5 shadow-sm">
              <Check :size="8" stroke-width="4" />
            </div>
          </div>
          
          <div class="flex-1 min-w-0">
            <div class="text-[13px] font-semibold truncate">{{ tab.title }}</div>
            <div class="text-[10px] opacity-60 truncate font-mono">{{ tab.url }}</div>
          </div>
        </button>
      </div>
    </div>

    <!-- Gemini-style Compound Input Container -->
    <div 
      class="flex flex-col border border-ui-border rounded-[28px] bg-ui-bg transition-all duration-300 focus-within:border-ui-text/20 focus-within:shadow-[0_4px_24px_rgba(0,0,0,0.06)] overflow-hidden"
    >
      <!-- Dynamic Context Header -->
      <div 
        v-if="selectedTabs.length > 0"
        class="flex items-center justify-between px-5 py-2.5 bg-ui-surface border-b border-ui-border/50 animate-in fade-in duration-300"
      >
        <div class="flex items-center gap-2 overflow-hidden">
          <template v-if="selectedTabs.length === 1">
            <img v-if="selectedTabs[0].favIconUrl" :src="selectedTabs[0].favIconUrl" class="w-3.5 h-3.5 rounded-sm" />
            <Globe v-else :size="14" class="text-ui-text-muted" />
            <span class="text-[12px] font-bold text-ui-text truncate">{{ selectedTabs[0].title }}</span>
          </template>
          <template v-else>
            <div class="flex -space-x-2 mr-1">
              <div v-for="tab in selectedTabs.slice(0, 3)" :key="tab.id" class="w-5 h-5 rounded-full border-2 border-white dark:border-[#2b2d2f] bg-ui-surface flex items-center justify-center overflow-hidden shrink-0">
                <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-full h-full" />
                <Globe v-else :size="10" />
              </div>
            </div>
            <span class="text-[12px] font-bold text-ui-text">Sharing {{ selectedTabs.length }} tabs</span>
          </template>
        </div>
        <button 
          @click="selectedTabs = []" 
          class="p-1 hover:bg-black/5 rounded-full text-ui-text-muted transition-colors"
        >
          <X :size="14" />
        </button>
      </div>

      <div v-else class="flex items-center gap-2 px-5 py-2.5 bg-ui-surface/40 border-b border-ui-border/50">
        <Sparkles :size="13" class="text-gemini-accent" fill="currentColor" />
        <span class="text-[10px] font-bold tracking-[0.1em] uppercase text-ui-text-muted/70">Agent Active • CDP Ready</span>
      </div>

      <div class="flex flex-col p-2 min-h-[90px]">
        <textarea
          ref="textarea"
          v-model="text"
          class="flex-1 w-full p-3 bg-transparent border-none focus:ring-0 focus:outline-none resize-none text-[14px] leading-relaxed placeholder:text-ui-text-muted/40 font-sans text-ui-text"
          placeholder="请输入指令或输入 @ 选择页面..."
          :disabled="disabled"
          @keydown="handleKeydown"
        />

        <div class="flex items-center justify-between px-2 pb-2 mt-auto">
          <div class="flex items-center gap-1">
            <button class="p-2 text-ui-text-muted hover:text-ui-text hover:bg-ui-surface rounded-full transition-all" @click="void refreshTabs(); showMentionList = !showMentionList">
              <Plus :size="20" />
            </button>
          </div>

          <div class="flex items-center gap-3">
            <button class="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-ui-text-muted hover:text-ui-text hover:bg-ui-surface rounded-full border border-ui-border transition-all">
              <span>实时模式</span>
              <ChevronDown :size="12" />
            </button>

            <button
              v-if="isRunning"
              class="p-2.5 bg-black text-white rounded-full hover:opacity-80 transition-all shadow-sm"
              @click="$emit('stop')"
            >
              <Square :size="16" fill="currentColor" />
            </button>
            <button
              v-else
              class="p-2.5 rounded-full transition-all"
              :class="canSend ? 'bg-ui-surface text-gemini-accent hover:bg-gemini-accent hover:text-white shadow-sm' : 'text-ui-text-muted opacity-20 cursor-not-allowed'"
              :disabled="!canSend"
              @click="handleSend"
            >
              <Send :size="20" />
            </button>
          </div>
        </div>
      </div>
    </div>
    
    <div class="mt-3 text-center">
      <p class="text-[9px] font-bold text-ui-text-muted/30 uppercase tracking-[0.2em]">
        Self-Evolving Browser System
      </p>
    </div>
  </div>
</template>

<style scoped>
textarea {
  outline: none !important;
  box-shadow: none !important;
  border: none !important;
}
textarea::-webkit-scrollbar {
  display: none;
}
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: var(--border);
  border-radius: 10px;
}
</style>
