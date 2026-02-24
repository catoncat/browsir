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
  <div class="w-full bg-ui-bg relative px-3 pb-4 pt-2">
    <!-- Mention Dropdown -->
    <div 
      v-if="showMentionList" 
      ref="mentionContainer"
      class="absolute bottom-[calc(100%-8px)] left-4 right-4 z-50 bg-ui-bg border border-ui-border rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2 duration-200"
      role="listbox"
      aria-label="选择标签页进行引用"
    >
      <div class="px-3 py-1.5 bg-ui-surface border-b border-ui-border flex items-center justify-between">
        <div class="flex items-center gap-2 text-[10px] font-bold text-ui-text-muted uppercase tracking-widest">
          <Search :size="10" aria-hidden="true" />
          Recent Tabs
        </div>
      </div>
      
      <div ref="listScrollContainer" class="max-h-56 overflow-y-auto custom-scrollbar">
        <button 
          v-for="(tab, index) in filteredTabs" 
          :id="`tab-item-${index}`"
          :key="tab.id"
          role="option"
          :aria-selected="focusedIndex === index"
          class="w-full flex items-center gap-2.5 px-3 py-2 transition-colors text-left border-b border-ui-border/30 last:border-0 outline-none"
          :class="[
            focusedIndex === index ? 'bg-ui-surface' : '',
            isTabSelected(tab.id) ? 'bg-ui-accent/5' : ''
          ]"
          @mouseenter="focusedIndex = index"
          @click="toggleTabSelection(tab)"
        >
          <div class="shrink-0">
            <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-4 h-4 rounded-sm" aria-hidden="true" />
            <Globe v-else :size="16" class="text-ui-text-muted" aria-hidden="true" />
          </div>
          
          <div class="flex-1 min-w-0">
            <div class="text-[12px] font-medium text-ui-text truncate">{{ tab.title }}</div>
            <div class="text-[9px] text-ui-text-muted truncate opacity-60 font-mono tracking-tight">{{ tab.url }}</div>
          </div>

          <div v-if="isTabSelected(tab.id)" class="shrink-0 text-ui-accent">
            <Check :size="14" stroke-width="3" aria-label="已选择" />
          </div>
        </button>
      </div>
    </div>

    <!-- GEMINI STYLE CONTAINER -->
    <div class="flex flex-col bg-ui-surface border border-ui-border rounded-2xl shadow-sm overflow-hidden transition-all focus-within:ring-1 focus-within:ring-ui-accent/20 focus-within:border-ui-accent/40">
      
      <!-- Integrated Sharing Header (Top of Card) -->
      <div 
        v-if="selectedTabs.length > 0"
        class="flex flex-col bg-ui-surface/60 border-b border-ui-border/30"
      >
        <div class="flex items-center justify-between px-4 py-2.5">
          <div class="flex items-center gap-2 overflow-hidden">
            <div class="flex -space-x-1 mr-1">
              <div 
                v-for="(tab, i) in selectedTabs.slice(0, 3)" 
                :key="tab.id" 
                class="w-5 h-5 rounded border border-ui-border bg-white flex items-center justify-center overflow-hidden shrink-0 shadow-sm"
                :style="{ zIndex: 10 - i }"
              >
                <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-full h-full object-contain" aria-hidden="true" />
                <Globe v-else :size="10" aria-hidden="true" />
              </div>
            </div>
            <span class="text-[13px] font-medium text-ui-text truncate">
              {{ selectedTabs.length === 1 ? selectedTabs[0].title : `正在共享 ${selectedTabs.length} 个标签页` }}
            </span>
          </div>
          
          <div class="flex items-center gap-0.5 shrink-0">
            <button 
              v-if="selectedTabs.length > 1"
              @click="isContextExpanded = !isContextExpanded"
              class="p-1.5 hover:bg-black/5 rounded-md text-ui-text-muted transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
              :aria-label="isContextExpanded ? '收起详情' : '查看共享详情'"
              :aria-expanded="isContextExpanded"
            >
              <ChevronUp v-if="!isContextExpanded" :size="16" aria-hidden="true" />
              <ChevronDown v-else :size="16" aria-hidden="true" />
            </button>
            <button 
              @click="selectedTabs = []; isContextExpanded = false" 
              class="p-1.5 hover:bg-black/5 rounded-md text-ui-text-muted transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
              aria-label="移除所有共享标签页"
            >
              <X :size="16" aria-hidden="true" />
            </button>
          </div>
        </div>

        <!-- Expanded Tab Details -->
        <div v-if="isContextExpanded" class="px-4 pb-3 space-y-1 animate-in slide-in-from-top-1 duration-200" role="list">
          <div 
            v-for="tab in selectedTabs" 
            :key="tab.id"
            class="flex items-center justify-between group/tab bg-white/50 border border-ui-border/50 px-2 py-1 rounded-md"
            role="listitem"
          >
            <div class="flex items-center gap-2 overflow-hidden">
              <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-3 h-3 shrink-0 rounded-sm" aria-hidden="true" />
              <Globe v-else :size="10" class="text-ui-text-muted shrink-0" aria-hidden="true" />
              <span class="text-[11px] text-ui-text truncate">{{ tab.title }}</span>
            </div>
            <button @click="removeTab(tab.id)" class="p-1 text-ui-text-muted hover:text-red-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 rounded-sm" :aria-label="`移除 ${tab.title}`">
              <X :size="10" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <!-- Main Input Flow -->
      <div class="flex flex-col">
        <textarea
          ref="textarea"
          v-model="text"
          class="w-full p-4 pb-2 bg-transparent border-none resize-none text-[15px] leading-relaxed placeholder:text-ui-text-muted/60 font-sans text-ui-text focus:outline-none min-h-[60px]"
          placeholder="Type @ to ask about a tab"
          :disabled="disabled"
          aria-label="消息输入框"
          @keydown="handleKeydown"
        />

        <div class="flex items-center justify-between px-3 pb-3">
          <div class="flex items-center gap-1">
            <button 
              class="p-2 text-ui-text-muted hover:text-ui-text hover:bg-black/5 rounded-lg transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
              aria-label="添加附件或引用标签页"
              aria-haspopup="listbox"
              :aria-expanded="showMentionList"
              @click="void refreshTabs(); showMentionList = !showMentionList"
            >
              <Plus :size="20" aria-hidden="true" />
            </button>
          </div>

          <div class="flex items-center gap-2">
            <button
              v-if="isRunning"
              class="p-2.5 bg-black text-white rounded-xl hover:opacity-80 transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              aria-label="停止生成"
              @click="$emit('stop')"
            >
              <Square :size="14" fill="currentColor" aria-hidden="true" />
            </button>
            <button
              v-else
              class="p-2.5 rounded-xl transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :class="canSend ? 'bg-ui-accent text-white hover:opacity-90' : 'bg-ui-surface text-ui-text-muted/30'"
              :disabled="!canSend"
              aria-label="发送消息"
              @click="handleSend"
            >
              <Send :size="18" aria-hidden="true" />
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
