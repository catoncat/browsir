<script setup lang="ts">
import { ref, watch, computed, nextTick } from "vue";
import { Send, Square, Plus, ChevronDown, ChevronUp, X, Globe, Search, Check } from "lucide-vue-next";
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
const isContextExpanded = ref(false);
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
const canSend = computed(() => text.value.trim().length > 0 && !props.disabled && !props.isRunning);

watch(
  () => props.modelValue,
  (newVal) => {
    const normalized = String(newVal || "");
    if (normalized !== text.value) {
      text.value = normalized;
    }
  },
  { immediate: true }
);

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
      focusedIndex.value = 0;
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

function removeTab(id: number) {
  selectedTabs.value = selectedTabs.value.filter(t => t.id !== id);
  if (selectedTabs.value.length === 0) isContextExpanded.value = false;
}

function confirmSelection() {
  if (selectedTabs.value.length === 0 && filteredTabs.value[focusedIndex.value]) {
    toggleTabSelection(filteredTabs.value[focusedIndex.value]);
  }
  text.value = text.value.replace(/@\w*$/, "");
  showMentionList.value = false;
  textarea.value?.focus();
}

function handleKeydown(e: KeyboardEvent) {
  if (showMentionList.value) {
    const total = filteredTabs.value.length;
    if (total === 0) {
      if (e.key === "Escape") showMentionList.value = false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusedIndex.value = (focusedIndex.value + 1) % total;
      scrollToFocused();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusedIndex.value = (focusedIndex.value - 1 + total) % total;
      scrollToFocused();
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirmSelection();
    } else if (e.key === " ") {
      e.preventDefault();
      const currentTab = filteredTabs.value[focusedIndex.value];
      if (currentTab) toggleTabSelection(currentTab);
    } else if (e.key === "Escape") {
      showMentionList.value = false;
    }
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    if (e.isComposing || e.keyCode === 229) return;
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
}
</script>

<template>
  <div class="w-full bg-ui-bg relative flex flex-col border-t border-ui-border">
    <!-- Mention Dropdown (RE-DESIGNED: COMPACT) -->
    <div 
      v-if="showMentionList" 
      ref="mentionContainer"
      class="absolute bottom-full left-0 right-0 z-50 bg-ui-bg border-t border-ui-border shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2 duration-200"
    >
      <div class="px-3 py-1.5 bg-ui-surface border-b border-ui-border flex items-center justify-between">
        <div class="flex items-center gap-2 text-[10px] font-bold text-ui-text-muted uppercase tracking-widest">
          <Search :size="10" />
          Recent Tabs
        </div>
        <div class="text-[9px] text-ui-text-muted opacity-60 font-bold uppercase">
          Space: Toggle • Enter: OK
        </div>
      </div>
      
      <div ref="listScrollContainer" class="max-h-56 overflow-y-auto custom-scrollbar">
        <button 
          v-for="(tab, index) in filteredTabs" 
          :id="`tab-item-${index}`"
          :key="tab.id"
          class="w-full flex items-center gap-2.5 px-3 py-2 transition-colors text-left border-b border-ui-border/30 last:border-0"
          :class="[focusedIndex === index ? 'bg-ui-surface' : '']"
          @mouseenter="focusedIndex = index"
          @click="toggleTabSelection(tab)"
        >
          <div class="relative shrink-0">
            <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-3.5 h-3.5 rounded-sm" />
            <Globe v-else :size="14" class="text-ui-text-muted" />
            <div v-if="isTabSelected(tab.id)" class="absolute -top-1 -right-1 bg-ui-accent text-white rounded-full p-0.5 shadow-sm">
              <Check :size="6" stroke-width="5" />
            </div>
          </div>
          
          <div class="flex-1 min-w-0">
            <div class="text-[12px] font-medium text-ui-text truncate">{{ tab.title }}</div>
            <div class="text-[9px] text-ui-text-muted truncate opacity-60 font-mono tracking-tight">{{ tab.url }}</div>
          </div>
        </button>
      </div>
    </div>

    <!-- DOCKED FULL-WIDTH INPUT AREA -->
    <div class="flex flex-col bg-ui-bg w-full">
      <!-- REPLICATED ICON STACKING: Integrated Context Header -->
      <div 
        v-if="selectedTabs.length > 0"
        class="flex flex-col bg-ui-surface border-b border-ui-border transition-colors animate-in fade-in slide-in-from-top-1 duration-200"
      >
        <div class="flex items-center justify-between px-4 py-2.5">
          <div class="flex items-center gap-2 overflow-hidden">
            <!-- Icon Stack Logic -->
            <div v-if="selectedTabs.length > 0" class="flex items-center gap-2">
              <div class="flex -space-x-1.5 mr-1">
                <div 
                  v-for="(tab, i) in selectedTabs.slice(0, 3)" 
                  :key="tab.id" 
                  class="w-5 h-5 rounded-md border border-ui-border bg-white flex items-center justify-center overflow-hidden shrink-0 shadow-sm"
                  :style="{ zIndex: 10 - i }"
                >
                  <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-full h-full object-contain" />
                  <Globe v-else :size="10" />
                </div>
              </div>
              <span class="text-[12px] font-bold text-ui-text truncate">
                {{ selectedTabs.length === 1 ? selectedTabs[0].title : `Sharing ${selectedTabs.length} tabs` }}
              </span>
            </div>
          </div>
          
          <div class="flex items-center gap-1 shrink-0">
            <button 
              v-if="selectedTabs.length > 1"
              @click="isContextExpanded = !isContextExpanded"
              class="p-1.5 hover:bg-black/5 rounded-md text-ui-text-muted transition-colors"
            >
              <ChevronDown v-if="!isContextExpanded" :size="16" />
              <ChevronUp v-else :size="16" />
            </button>
            <button 
              v-if="selectedTabs.length > 0"
              @click="selectedTabs = []; isContextExpanded = false" 
              class="p-1.5 hover:bg-black/5 rounded-md text-ui-text-muted transition-colors"
            >
              <X :size="16" />
            </button>
          </div>
        </div>

        <!-- Expanded Tab Details -->
        <div v-if="isContextExpanded" class="px-4 pb-3 space-y-1.5 animate-in slide-in-from-top-1 duration-200">
          <div 
            v-for="tab in selectedTabs" 
            :key="tab.id"
            class="flex items-center justify-between group/tab bg-ui-bg/50 border border-ui-border/50 px-2 py-1.5 rounded-md"
          >
            <div class="flex items-center gap-2.5 overflow-hidden">
              <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-3.5 h-3.5 shrink-0 rounded-sm" />
              <Globe v-else :size="12" class="text-ui-text-muted shrink-0" />
              <span class="text-[11px] font-medium text-ui-text truncate">{{ tab.title }}</span>
            </div>
            <button @click="removeTab(tab.id)" class="p-1 text-ui-text-muted hover:text-red-500 transition-all">
              <X :size="12" />
            </button>
          </div>
        </div>
      </div>

      <!-- Main Input Flow -->
      <div class="flex flex-col min-h-[80px]">
        <textarea
          ref="textarea"
          v-model="text"
          class="flex-1 w-full p-4 bg-transparent border-none resize-none text-[14px] leading-relaxed placeholder:text-ui-text-muted/70 font-sans text-ui-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/70"
          placeholder="给 Agent 发送指令或输入 @ 选择页面..."
          :disabled="disabled"
          @keydown="handleKeydown"
        />

        <div class="flex items-center justify-between px-3 pb-3 mt-auto">
          <div class="flex items-center gap-1">
            <button 
              class="p-2 text-ui-text-muted hover:text-ui-text hover:bg-ui-surface rounded-md transition-all active:scale-95"
              @click="void refreshTabs(); showMentionList = !showMentionList"
            >
              <Plus :size="18" />
            </button>
          </div>

          <div class="flex items-center gap-2.5">
            <button class="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-ui-text-muted hover:text-ui-text hover:bg-ui-surface rounded-md border border-ui-border transition-all">
              <span>Fast</span>
              <ChevronDown :size="12" />
            </button>

            <button
              v-if="isRunning"
              class="p-2.5 bg-black text-white rounded-md hover:opacity-80 transition-all"
              @click="$emit('stop')"
            >
              <Square :size="14" fill="currentColor" />
            </button>
            <button
              v-else
              class="p-2.5 rounded-md transition-all"
              :class="canSend ? 'bg-ui-accent text-white hover:opacity-90 shadow-sm' : 'bg-ui-surface text-ui-text-muted opacity-30 cursor-not-allowed'"
              :disabled="!canSend"
              @click="handleSend"
            >
              <Send :size="18" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
textarea::-webkit-scrollbar {
  display: none;
}
.custom-scrollbar::-webkit-scrollbar {
  width: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: var(--border);
  border-radius: 10px;
}
</style>
