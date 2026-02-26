<script setup lang="ts">
import { ref, watch, computed, nextTick } from "vue";
import { Send, Square, Plus, ChevronDown, ChevronUp, X, Globe, Search, Check, Loader2, Wrench } from "lucide-vue-next";
import { useTextareaAutosize, onClickOutside } from "@vueuse/core";
import { useRuntimeStore, type SkillMetadata } from "../stores/runtime";

interface TabItem {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

interface QueueItem {
  id: string;
  behavior: "steer" | "followUp";
  text: string;
}

interface SkillOption {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  disableModelInvocation: boolean;
}

const props = defineProps<{
  disabled?: boolean;
  isRunning?: boolean;
  isCompacting?: boolean;
  isStartingRun?: boolean;
  modelValue: string;
  queueItems?: QueueItem[];
  queuePromotingIds?: string[];
  queueState?: {
    steer?: number;
    followUp?: number;
    total?: number;
  };
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "send", payload: { text: string; tabIds: number[]; skillIds: string[]; mode: "normal" | "steer" | "followUp" }): void;
  (e: "queue-promote", payload: { id: string }): void;
  (e: "stop"): void;
}>();

const { textarea, input: text } = useTextareaAutosize();
const runtimeStore = useRuntimeStore();
const selectedTabs = ref<TabItem[]>([]);
const availableTabs = ref<TabItem[]>([]);
const showMentionList = ref(false);
const showSkillList = ref(false);
const isContextExpanded = ref(false);
const mentionFilter = ref("");
const skillFilter = ref("");
const focusedIndex = ref(0);
const skillFocusedIndex = ref(0);
const mentionContainer = ref<HTMLElement | null>(null);
const skillContainer = ref<HTMLElement | null>(null);
const listScrollContainer = ref<HTMLElement | null>(null);
const skillListScrollContainer = ref<HTMLElement | null>(null);
const availableSkills = ref<SkillOption[]>([]);
const selectedSkills = ref<SkillOption[]>([]);
const skillLoading = ref(false);
const skillError = ref("");
const skillCacheUpdatedAt = ref(0);

const SKILL_CACHE_TTL_MS = 8000;

onClickOutside(mentionContainer, () => {
  showMentionList.value = false;
});
onClickOutside(skillContainer, () => {
  showSkillList.value = false;
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
const filteredSkills = computed(() => {
  const q = skillFilter.value.toLowerCase().trim();
  const selectedIdSet = new Set(selectedSkills.value.map((item) => item.id));
  const list = availableSkills.value.filter((skill) => skill.enabled && !selectedIdSet.has(skill.id));
  if (!q) return list;
  return list.filter((skill) => {
    return (
      skill.id.toLowerCase().includes(q) ||
      skill.name.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q)
    );
  });
});
const isCompacting = computed(() => Boolean(props.isCompacting) && Boolean(props.isRunning));
const isStartingRun = computed(() => Boolean(props.isStartingRun) && !props.isRunning);
const canSubmit = computed(() =>
  (text.value.trim().length > 0 || selectedSkills.value.length > 0) && !props.disabled && !isStartingRun.value
);
const queueItems = computed<QueueItem[]>(() => {
  return Array.isArray(props.queueItems) ? props.queueItems : [];
});
const queuePromotingIdSet = computed(() => {
  return new Set((Array.isArray(props.queuePromotingIds) ? props.queuePromotingIds : []).map((id) => String(id || "").trim()));
});

function isQueuePromoting(id: string): boolean {
  const normalized = String(id || "").trim();
  if (!normalized) return false;
  return queuePromotingIdSet.value.has(normalized);
}

function handleQueuePromote(id: string): void {
  const normalized = String(id || "").trim();
  if (!normalized) return;
  emit("queue-promote", { id: normalized });
}

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
  const slashContext = extractSlashContext(newVal);
  if (slashContext) {
    if (!showSkillList.value) {
      void refreshSkills();
    }
    const nextSkillFilter = slashContext.query;
    if (nextSkillFilter !== skillFilter.value) {
      skillFocusedIndex.value = 0;
    }
    skillFilter.value = nextSkillFilter;
    showSkillList.value = true;
    showMentionList.value = false;
  } else {
    showSkillList.value = false;
    skillFilter.value = "";
  }

  const lastChar = newVal.slice(-1);
  if (!slashContext) {
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

function removeSkillSelection(id: string) {
  const normalized = String(id || "").trim();
  if (!normalized) return;
  selectedSkills.value = selectedSkills.value.filter((item) => item.id !== normalized);
}

function addSkillSelection(skill: SkillOption) {
  if (!skill?.id) return;
  if (selectedSkills.value.some((item) => item.id === skill.id)) return;
  selectedSkills.value.push(skill);
}

function confirmSelection() {
  if (selectedTabs.value.length === 0 && filteredTabs.value[focusedIndex.value]) {
    toggleTabSelection(filteredTabs.value[focusedIndex.value]);
  }
  text.value = text.value.replace(/@\w*$/, "");
  showMentionList.value = false;
  textarea.value?.focus();
}

function normalizeSkill(input: SkillMetadata): SkillOption | null {
  const id = String(input.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: String(input.name || "").trim() || id,
    description: String(input.description || "").trim(),
    enabled: input.enabled === true,
    disableModelInvocation: input.disableModelInvocation === true
  };
}

async function refreshSkills(options: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (
    !options.force &&
    availableSkills.value.length > 0 &&
    now - Number(skillCacheUpdatedAt.value || 0) < SKILL_CACHE_TTL_MS
  ) {
    return;
  }
  if (skillLoading.value) return;
  skillLoading.value = true;
  skillError.value = "";
  try {
    const listed = await runtimeStore.listSkills();
    const normalized = listed
      .map((item) => normalizeSkill(item))
      .filter((item): item is SkillOption => Boolean(item))
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    availableSkills.value = normalized;
    skillCacheUpdatedAt.value = now;
  } catch (error) {
    skillError.value = error instanceof Error ? error.message : String(error);
  } finally {
    skillLoading.value = false;
  }
}

interface SlashContext {
  start: number;
  end: number;
  query: string;
}

function extractSlashContext(value: string): SlashContext | null {
  const source = String(value || "");
  const cursor = Number(textarea.value?.selectionStart ?? source.length);
  const head = source.slice(0, cursor);
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(head);
  if (!match) return null;
  const whole = match[0];
  const leadingWhitespaceOffset = whole.startsWith(" ") ? 1 : 0;
  const start = head.length - whole.length + leadingWhitespaceOffset;
  const rawQuery = String(match[1] || "");
  const query = rawQuery.startsWith("skill:") ? rawQuery.slice("skill:".length) : rawQuery;
  return {
    start,
    end: cursor,
    query
  };
}

function confirmSkillSelection(skill = filteredSkills.value[skillFocusedIndex.value]) {
  if (!skill) return;
  const context = extractSlashContext(text.value);
  if (!context) {
    showSkillList.value = false;
    return;
  }
  addSkillSelection(skill);
  const before = text.value.slice(0, context.start);
  const after = text.value.slice(context.end);
  const merged = before.endsWith(" ") && after.startsWith(" ") ? `${before}${after.slice(1)}` : `${before}${after}`;
  text.value = merged;
  showSkillList.value = false;
  skillFilter.value = "";
  nextTick(() => {
    const cursor = before.length;
    const target = textarea.value;
    target?.focus();
    target?.setSelectionRange(cursor, cursor);
  });
}

function handleKeydown(e: KeyboardEvent) {
  if (showSkillList.value) {
    const total = filteredSkills.value.length;
    if (total === 0) {
      if (e.key === "Escape") showSkillList.value = false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Tab") {
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        showSkillList.value = false;
      } else {
        return;
      }
    }

    if (!showSkillList.value) {
      // fall through to normal submit handling (e.g. Enter)
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      skillFocusedIndex.value = (skillFocusedIndex.value + 1) % total;
      scrollToFocusedSkill();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      skillFocusedIndex.value = (skillFocusedIndex.value - 1 + total) % total;
      scrollToFocusedSkill();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      confirmSkillSelection();
    } else if (e.key === "Escape") {
      showSkillList.value = false;
    }
    if (showSkillList.value) {
      return;
    }
  }

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
    if (props.isRunning) {
      handleSubmit(e.altKey ? "followUp" : "steer");
      return;
    }
    handleSubmit("normal");
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

function scrollToFocusedSkill() {
  nextTick(() => {
    const el = document.getElementById(`skill-item-${skillFocusedIndex.value}`);
    if (el && skillListScrollContainer.value) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

function handleSubmit(mode: "normal" | "steer" | "followUp") {
  if ((text.value.trim().length === 0 && selectedSkills.value.length === 0) || props.disabled || isStartingRun.value) return;
  const resolvedMode = props.isRunning ? (mode === "normal" ? "steer" : mode) : "normal";
  emit("send", {
    text: text.value,
    tabIds: selectedTabs.value.map(t => t.id),
    skillIds: selectedSkills.value.map((item) => item.id),
    mode: resolvedMode
  });
  text.value = "";
  selectedSkills.value = [];
  showMentionList.value = false;
  showSkillList.value = false;
  skillFilter.value = "";
}
</script>

<template>
  <div class="w-full bg-ui-bg relative px-3 pb-4 pt-2">
    <!-- Skill Slash Dropdown -->
    <div
      v-if="showSkillList"
      ref="skillContainer"
      class="absolute bottom-[calc(100%-8px)] left-4 right-4 z-50 bg-ui-bg border border-ui-border rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2 duration-200"
      role="listbox"
      aria-label="选择 skill"
    >
      <div class="px-3 py-1.5 bg-ui-surface border-b border-ui-border flex items-center justify-between">
        <div class="flex items-center gap-2 text-[10px] font-bold text-ui-text-muted uppercase tracking-widest">
          <Wrench :size="10" aria-hidden="true" />
          Skills
        </div>
        <button
          type="button"
          class="text-[10px] text-ui-text-muted hover:text-ui-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent rounded px-1"
          aria-label="刷新 skills 列表"
          @click="void refreshSkills({ force: true })"
        >
          刷新
        </button>
      </div>

      <div v-if="skillLoading" class="px-3 py-3 text-[12px] text-ui-text-muted inline-flex items-center gap-2">
        <Loader2 :size="13" class="animate-spin" aria-hidden="true" />
        正在加载 skills...
      </div>
      <div v-else-if="skillError" class="px-3 py-3 text-[12px] text-rose-600">
        {{ skillError }}
      </div>
      <div v-else-if="filteredSkills.length === 0" class="px-3 py-3 text-[12px] text-ui-text-muted">
        没有可用的已启用 skills。先去“Skills 管理”页启用或创建。
      </div>
      <div v-else ref="skillListScrollContainer" class="max-h-56 overflow-y-auto custom-scrollbar">
        <button
          v-for="(skill, index) in filteredSkills"
          :id="`skill-item-${index}`"
          :key="skill.id"
          role="option"
          :aria-selected="skillFocusedIndex === index"
          class="w-full flex items-start gap-2 px-3 py-2 transition-colors text-left border-b border-ui-border/30 last:border-0 outline-none"
          :class="skillFocusedIndex === index ? 'bg-ui-surface' : ''"
          @mouseenter="skillFocusedIndex = index"
          @click="confirmSkillSelection(skill)"
        >
          <div class="mt-0.5 shrink-0 text-ui-accent">
            <Wrench :size="14" aria-hidden="true" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-[12px] font-medium text-ui-text truncate">{{ skill.name }}</span>
              <span
                v-if="skill.disableModelInvocation"
                class="text-[9px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5"
              >
                manual
              </span>
            </div>
            <div class="text-[10px] text-ui-text-muted font-mono truncate">/skill:{{ skill.id }}</div>
            <div v-if="skill.description" class="text-[10px] text-ui-text-muted truncate">{{ skill.description }}</div>
          </div>
        </button>
      </div>
    </div>

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
        <div class="h-8 px-2.5 flex items-center justify-between gap-2">
          <div class="min-w-0 flex items-center gap-1.5 overflow-hidden">
            <div class="flex -space-x-1 shrink-0">
              <div
                v-for="(tab, i) in selectedTabs.slice(0, 2)"
                :key="tab.id"
                class="w-4 h-4 rounded border border-ui-border bg-white flex items-center justify-center overflow-hidden"
                :style="{ zIndex: 10 - i }"
              >
                <img v-if="tab.favIconUrl" :src="tab.favIconUrl" class="w-full h-full object-contain" aria-hidden="true" />
                <Globe v-else :size="9" aria-hidden="true" />
              </div>
              <span
                v-if="selectedTabs.length > 2"
                class="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-ui-border bg-ui-bg px-1 text-[9px] text-ui-text-muted"
              >
                +{{ selectedTabs.length - 2 }}
              </span>
            </div>
            <span class="truncate text-[11px] font-medium text-ui-text">
              {{ selectedTabs.length === 1 ? selectedTabs[0].title : `${selectedTabs.length} 个标签页` }}
            </span>
          </div>

          <div class="flex items-center gap-0.5 shrink-0">
            <button
              v-if="selectedTabs.length > 1"
              @click="isContextExpanded = !isContextExpanded"
              class="h-5 w-5 inline-flex items-center justify-center hover:bg-black/5 rounded-md text-ui-text-muted transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
              :aria-label="isContextExpanded ? '收起详情' : '查看共享详情'"
              :aria-expanded="isContextExpanded"
              :title="isContextExpanded ? '收起详情' : '管理共享标签页'"
            >
              <ChevronDown v-if="!isContextExpanded" :size="11" aria-hidden="true" />
              <ChevronUp v-else :size="11" aria-hidden="true" />
            </button>
            <button
              @click="selectedTabs = []; isContextExpanded = false"
              class="h-5 w-5 inline-flex items-center justify-center hover:bg-black/5 rounded-md text-ui-text-muted transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
              aria-label="移除所有共享标签页"
              title="移除所有共享标签页"
            >
              <X :size="11" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div v-if="isContextExpanded" class="px-2.5 pb-2 space-y-1 animate-in slide-in-from-top-1 duration-200" role="list">
          <div
            v-for="tab in selectedTabs"
            :key="tab.id"
            class="h-7 flex items-center justify-between group/tab bg-white/50 border border-ui-border/50 px-2 rounded-md"
            role="listitem"
          >
            <div class="flex items-center gap-1.5 overflow-hidden">
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
        <div
          v-if="selectedSkills.length > 0"
          class="flex flex-wrap gap-1.5 px-3 pt-3 pb-2 border-b border-ui-border/30"
          role="list"
          aria-label="已选择技能"
        >
          <div
            v-for="skill in selectedSkills"
            :key="skill.id"
            class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-ui-border bg-ui-bg px-2 py-1"
            role="listitem"
          >
            <Wrench :size="11" class="shrink-0 text-ui-accent" aria-hidden="true" />
            <span class="truncate text-[11px] font-medium text-ui-text">
              {{ skill.name }}
            </span>
            <button
              type="button"
              class="shrink-0 rounded-full p-0.5 text-ui-text-muted transition-colors hover:bg-ui-surface hover:text-ui-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
              :aria-label="`移除技能 ${skill.name}`"
              @click="removeSkillSelection(skill.id)"
            >
              <X :size="11" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div
          v-if="isRunning && queueItems.length > 0"
          class="flex flex-col bg-ui-surface/70 border-b border-ui-border/30"
          role="region"
          aria-label="排队消息"
        >
          <div class="px-4 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ui-text-muted" role="status" aria-live="polite">
            Queue {{ queueItems.length }} 条
          </div>
          <div class="px-3 pb-2 pt-1 space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar" role="list">
            <div
              v-for="item in queueItems"
              :key="item.id"
              class="flex items-start gap-2 rounded-lg border border-ui-border/50 bg-ui-bg/85 px-2.5 py-2"
              role="listitem"
              :aria-label="`排队消息：${item.behavior === 'steer' ? 'steer' : 'followUp'}`"
            >
              <div class="min-w-0 flex-1">
                <div class="text-[10px] font-semibold text-ui-text-muted">
                  {{ item.behavior === "steer" ? "Steer" : "FollowUp" }}
                </div>
                <div class="mt-1 whitespace-pre-wrap break-words text-[12px] leading-snug text-ui-text">
                  {{ item.text }}
                </div>
              </div>
              <button
                v-if="item.behavior !== 'steer'"
                type="button"
                class="shrink-0 p-1.5 rounded-md text-ui-text-muted hover:text-ui-accent hover:bg-ui-accent/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent disabled:opacity-50"
                :disabled="isQueuePromoting(item.id)"
                :aria-label="isQueuePromoting(item.id) ? '正在直接插入' : '直接插入'"
                :title="isQueuePromoting(item.id) ? '正在直接插入' : '直接插入（steer）'"
                @click="handleQueuePromote(item.id)"
              >
                <Loader2 v-if="isQueuePromoting(item.id)" :size="13" class="animate-spin" aria-hidden="true" />
                <Send v-else :size="13" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        <div
          v-if="isStartingRun"
          class="px-4 pt-2 text-[10px] font-medium text-ui-text-muted inline-flex items-center gap-1.5"
          role="status"
          aria-live="polite"
        >
          <Loader2 :size="11" class="animate-spin" aria-hidden="true" />
          <span>正在启动响应…</span>
        </div>
        <div
          v-else-if="isCompacting"
          class="px-4 pt-2 text-[10px] font-medium text-ui-text-muted inline-flex items-center gap-1.5"
          role="status"
          aria-live="polite"
        >
          <Loader2 :size="11" class="animate-spin" aria-hidden="true" />
          <span>正在整理上下文，消息会排队</span>
        </div>
        <textarea
          ref="textarea"
          v-model="text"
          class="w-full p-4 pb-2 bg-transparent border-none resize-none text-[15px] leading-relaxed placeholder:text-ui-text-muted/60 font-sans text-ui-text focus:outline-none min-h-[60px]"
          placeholder="输入 / 选择 skill，输入 @ 引用标签页"
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
              class="p-2.5 rounded-xl transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :class="canSubmit ? 'bg-ui-accent text-white hover:opacity-90' : 'bg-ui-surface text-ui-text-muted/30'"
              :disabled="!canSubmit"
              :aria-label="isStartingRun ? '正在启动响应' : (isRunning ? '追加发送（默认 steer，Alt+Enter 为 followUp）' : '发送消息')"
              :title="isStartingRun ? '正在启动响应' : (isRunning ? '追加发送（默认 steer，Alt+Enter 为 followUp）' : '发送消息')"
              @click="handleSubmit('normal')"
            >
              <Loader2 v-if="isStartingRun" :size="18" class="animate-spin" aria-hidden="true" />
              <Send v-else :size="18" aria-hidden="true" />
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
