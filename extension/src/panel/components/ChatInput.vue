<script setup lang="ts">
import { ref, watch, computed, nextTick } from "vue";
import { Send, Square, Plus, ChevronDown, ChevronUp, X, Globe, Search, Check, Loader2, Wand2 } from "lucide-vue-next";
import { useTextareaAutosize, onClickOutside } from "@vueuse/core";
import { useRuntimeStore, type SkillMetadata } from "../stores/runtime";
import DropdownPanel from "./DropdownPanel.vue";

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

type SkillCommandMode = "select" | "manage";

interface DropdownPanelExpose {
  getRootEl: () => HTMLElement | null;
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
const mentionPanel = ref<DropdownPanelExpose | null>(null);
const skillPanel = ref<DropdownPanelExpose | null>(null);
const mentionContainer = computed(() => mentionPanel.value?.getRootEl() ?? null);
const skillContainer = computed(() => skillPanel.value?.getRootEl() ?? null);
const listScrollContainer = ref<HTMLElement | null>(null);
const skillListScrollContainer = ref<HTMLElement | null>(null);
const availableSkills = ref<SkillOption[]>([]);
const selectedSkills = ref<SkillOption[]>([]);
const skillCommandMode = ref<SkillCommandMode>("select");
const skillActionPendingIds = ref<Set<string>>(new Set());
const skillLoading = ref(false);
const skillError = ref("");
const skillCacheUpdatedAt = ref(0);

const SKILL_CACHE_TTL_MS = 8000;

onClickOutside(mentionContainer, () => {
  showMentionList.value = false;
});
onClickOutside(skillContainer, () => {
  showSkillList.value = false;
  skillCommandMode.value = "select";
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
  const list = availableSkills.value.filter((skill) =>
    skillCommandMode.value === "manage" ? true : skill.enabled && !selectedIdSet.has(skill.id)
  );
  if (!q) return list;
  return list.filter((skill) => {
    return (
      skill.id.toLowerCase().includes(q) ||
      skill.name.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q)
    );
  });
});
const isSkillsManageMode = computed(() => skillCommandMode.value === "manage");
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
    const modeChanged = skillCommandMode.value !== slashContext.mode;
    skillCommandMode.value = slashContext.mode;
    if (!showSkillList.value || modeChanged) {
      void refreshSkills({ force: true });
    }
    const nextSkillFilter = slashContext.query;
    if (nextSkillFilter !== skillFilter.value) {
      skillFocusedIndex.value = 0;
    }
    skillFilter.value = nextSkillFilter;
    showSkillList.value = true;
    showMentionList.value = false;
  } else {
    skillCommandMode.value = "select";
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

function sortSkillOptions(input: SkillOption[]): SkillOption[] {
  return [...input].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function setSkillActionPending(skillId: string, pending: boolean): void {
  const id = String(skillId || "").trim();
  if (!id) return;
  const next = new Set(skillActionPendingIds.value);
  if (pending) next.add(id);
  else next.delete(id);
  skillActionPendingIds.value = next;
}

function isSkillActionPending(skillId: string): boolean {
  const id = String(skillId || "").trim();
  if (!id) return false;
  return skillActionPendingIds.value.has(id);
}

function upsertSkillOption(next: SkillOption): void {
  const id = String(next.id || "").trim();
  if (!id) return;
  const merged = [...availableSkills.value];
  const index = merged.findIndex((item) => item.id === id);
  if (index >= 0) merged[index] = next;
  else merged.push(next);
  availableSkills.value = sortSkillOptions(merged);
  skillCacheUpdatedAt.value = Date.now();
}

async function setSkillEnabled(skill: SkillOption, enabled: boolean): Promise<SkillOption | null> {
  const id = String(skill?.id || "").trim();
  if (!id) return null;
  if (isSkillActionPending(id)) return null;
  setSkillActionPending(id, true);
  try {
    const updatedMeta = enabled ? await runtimeStore.enableSkill(id) : await runtimeStore.disableSkill(id);
    const normalized = normalizeSkill(updatedMeta);
    if (!normalized) {
      await refreshSkills({ force: true });
      return null;
    }
    upsertSkillOption(normalized);
    if (!normalized.enabled) {
      removeSkillSelection(normalized.id);
    }
    skillError.value = "";
    return normalized;
  } catch (error) {
    skillError.value = error instanceof Error ? error.message : String(error);
    return null;
  } finally {
    setSkillActionPending(id, false);
  }
}

async function toggleSkillEnabled(skill: SkillOption): Promise<void> {
  await setSkillEnabled(skill, !skill.enabled);
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
    const normalized = sortSkillOptions(
      listed
      .map((item) => normalizeSkill(item))
      .filter((item): item is SkillOption => Boolean(item))
    );
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
  mode: SkillCommandMode;
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
  const lower = rawQuery.toLowerCase();
  let mode: SkillCommandMode = "select";
  let query = rawQuery.startsWith("skill:") ? rawQuery.slice("skill:".length) : rawQuery;
  if (lower === "skills" || lower.startsWith("skills:")) {
    mode = "manage";
    query = rawQuery.includes(":") ? rawQuery.slice(rawQuery.indexOf(":") + 1) : "";
  }
  return {
    start,
    end: cursor,
    query,
    mode
  };
}

function replaceSlashContextAndFocus(context: SlashContext): void {
  const before = text.value.slice(0, context.start);
  const after = text.value.slice(context.end);
  const merged = before.endsWith(" ") && after.startsWith(" ") ? `${before}${after.slice(1)}` : `${before}${after}`;
  text.value = merged;
  nextTick(() => {
    const cursor = before.length;
    const target = textarea.value;
    target?.focus();
    target?.setSelectionRange(cursor, cursor);
  });
}

function confirmSkillSelection(skill = filteredSkills.value[skillFocusedIndex.value]) {
  if (!skill) return;
  const context = extractSlashContext(text.value);
  if (!context) {
    showSkillList.value = false;
    return;
  }
  addSkillSelection(skill);
  replaceSlashContextAndFocus(context);
  showSkillList.value = false;
  skillFilter.value = "";
  skillCommandMode.value = "select";
}

async function useSkillFromManage(skill = filteredSkills.value[skillFocusedIndex.value]): Promise<void> {
  if (!skill) return;
  let resolved = skill;
  if (!resolved.enabled) {
    const enabled = await setSkillEnabled(resolved, true);
    if (!enabled) return;
    resolved = enabled;
  }
  addSkillSelection(resolved);
  const context = extractSlashContext(text.value);
  if (context) {
    replaceSlashContextAndFocus(context);
  }
  showSkillList.value = false;
  skillFilter.value = "";
  skillCommandMode.value = "select";
}

function handleSkillRowClick(skill: SkillOption): void {
  if (isSkillsManageMode.value) {
    void useSkillFromManage(skill);
    return;
  }
  confirmSkillSelection(skill);
}

function handleKeydown(e: KeyboardEvent) {
  if (showSkillList.value) {
    const manageMode = isSkillsManageMode.value;
    const total = filteredSkills.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (total === 0) return;
      skillFocusedIndex.value = (skillFocusedIndex.value + 1) % total;
      scrollToFocusedSkill();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (total === 0) return;
      skillFocusedIndex.value = (skillFocusedIndex.value - 1 + total) % total;
      scrollToFocusedSkill();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      showSkillList.value = false;
      skillCommandMode.value = "select";
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (total === 0) {
        showSkillList.value = false;
        skillCommandMode.value = "select";
        return;
      }
      if (manageMode) {
        if (e.altKey) {
          void toggleSkillEnabled(filteredSkills.value[skillFocusedIndex.value]);
        } else {
          void useSkillFromManage(filteredSkills.value[skillFocusedIndex.value]);
        }
      } else {
        confirmSkillSelection();
      }
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
  skillCommandMode.value = "select";
}
</script>

<template>
  <div class="w-full bg-ui-bg relative px-3 pb-4 pt-2">
    <!-- Skill Slash Dropdown -->
    <DropdownPanel
      v-if="showSkillList"
      ref="skillPanel"
      title="Skills"
      aria-label="选择 skill"
    >
      <template #icon>
        <Wand2 :size="9" class="text-ui-text-muted/70 translate-y-px" aria-hidden="true" />
      </template>
      <div v-if="skillLoading" class="px-3 py-3 text-[12px] text-ui-text-muted inline-flex items-center gap-2">
        <Loader2 :size="13" class="animate-spin" aria-hidden="true" />
        正在加载 skills...
      </div>
      <div v-else-if="skillError" class="px-3 py-3 text-[12px] text-rose-600">
        {{ skillError }}
      </div>
      <div v-else-if="filteredSkills.length === 0" class="px-3 py-3 text-[12px] text-ui-text-muted">
        <template v-if="isSkillsManageMode">没有匹配的 skills，可先创建或 discover。</template>
        <template v-else-if="availableSkills.length === 0">快去 skills 管理添加吧</template>
        <template v-else>
          <kbd class="shortcut-kbd">/skills</kbd>
          <span class="ml-1">开启技能</span>
        </template>
      </div>
      <div v-else ref="skillListScrollContainer" class="max-h-56 overflow-y-auto custom-scrollbar">
        <button
          v-for="(skill, index) in filteredSkills"
          :id="`skill-item-${index}`"
          :key="skill.id"
          role="option"
          :aria-selected="skillFocusedIndex === index"
          class="group/skill w-full flex items-start gap-2 px-3 py-2 transition-colors text-left border-b border-ui-border/30 last:border-0 outline-none"
          :class="[skillFocusedIndex === index ? 'bg-ui-surface' : '', isSkillsManageMode && !skill.enabled ? 'skill-row-disabled' : '']"
          @mouseenter="skillFocusedIndex = index"
          @click="handleSkillRowClick(skill)"
        >
          <div
            class="mt-0.5 shrink-0 transition-colors"
            :class="skillFocusedIndex === index ? 'text-ui-accent' : 'text-ui-text-muted/60'"
          >
            <Wand2 :size="14" aria-hidden="true" />
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
            <div
              class="text-[10px] text-ui-text-muted font-mono truncate"
              :class="isSkillsManageMode && !skill.enabled ? 'opacity-70' : ''"
            >
              /skill:{{ skill.id }}
            </div>
            <div
              v-if="skill.description"
              class="text-[10px] text-ui-text-muted truncate"
              :class="isSkillsManageMode && !skill.enabled ? 'opacity-70' : ''"
            >
              {{ skill.description }}
            </div>
          </div>
          <div
            v-if="isSkillsManageMode"
            class="ml-2 shrink-0 self-center"
          >
            <button
              type="button"
              class="relative inline-flex h-6 w-[68px] items-center justify-center overflow-hidden rounded-md text-[10px] font-medium text-ui-text-muted transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent disabled:opacity-50"
              :disabled="isSkillActionPending(skill.id)"
              :aria-label="skill.enabled ? `禁用技能 ${skill.name}` : `启用技能 ${skill.name}`"
              @click.stop="void toggleSkillEnabled(skill)"
            >
              <Loader2 v-if="isSkillActionPending(skill.id)" :size="11" class="inline-block animate-spin" aria-hidden="true" />
              <template v-else>
                <span
                  class="pointer-events-none absolute inset-0 inline-flex items-center justify-center transition-all duration-200 ease-out group-hover/skill:-translate-y-1 group-hover/skill:scale-95 group-hover/skill:opacity-0"
                >
                  <span v-if="skill.enabled" class="h-2.5 w-2.5 rounded-full bg-ui-accent transition-all duration-200" aria-hidden="true"></span>
                  <span
                    v-else
                    class="inline-flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.08em] text-ui-text-muted/75"
                    aria-hidden="true"
                  >
                    <span class="h-2.5 w-2.5 rounded-full border border-ui-border bg-transparent"></span>
                    <span>OFF</span>
                  </span>
                </span>
                <span
                  class="pointer-events-none absolute inset-0 inline-flex items-center justify-center opacity-0 transition-all duration-200 ease-out translate-y-1 scale-95 group-hover/skill:translate-y-0 group-hover/skill:scale-100 group-hover/skill:opacity-100"
                  aria-hidden="true"
                >
                  <span
                    class="relative h-3.5 w-7 rounded-full border transition-colors duration-200"
                    :class="skill.enabled
                      ? 'border-ui-accent/50 bg-ui-accent/75'
                      : 'border-ui-border bg-ui-bg'"
                  >
                    <span
                      class="absolute left-[1px] top-[1px] h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform duration-200"
                      :class="skill.enabled ? 'translate-x-3' : 'translate-x-0'"
                    ></span>
                  </span>
                </span>
              </template>
            </button>
          </div>
        </button>
      </div>
      <template #footer>
        <div class="border-t border-ui-border/40 px-2.5 py-1.5 select-none pointer-events-none">
          <div class="flex flex-wrap items-center justify-end gap-2 text-[9px] text-ui-text-muted/65">
            <span class="shortcut-hint-item">
              <span class="shortcut-keys" role="text" aria-label="回车">
                <kbd class="shortcut-kbd">↵</kbd>
              </span>
              <span>{{ isSkillsManageMode ? "使用" : "选择" }}</span>
            </span>
            <span v-if="isSkillsManageMode" class="shortcut-hint-item">
              <span class="shortcut-keys" role="text" aria-label="Option 加回车">
                <kbd class="shortcut-kbd">⌥</kbd>
                <kbd class="shortcut-kbd">↵</kbd>
              </span>
              <span>开关</span>
            </span>
            <span class="shortcut-hint-item">
              <span class="shortcut-keys" role="text" aria-label="Esc">
                <kbd class="shortcut-kbd">⎋</kbd>
              </span>
              <span>关闭</span>
            </span>
          </div>
        </div>
      </template>
    </DropdownPanel>

    <!-- Mention Dropdown -->
    <DropdownPanel
      v-if="showMentionList"
      ref="mentionPanel"
      title="Recent Tabs"
      aria-label="选择标签页进行引用"
    >
      <template #icon>
        <Search :size="10" aria-hidden="true" />
      </template>
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
    </DropdownPanel>

    <!-- GEMINI STYLE CONTAINER -->
    <div class="composer-shell flex flex-col overflow-hidden">
      
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
            <Wand2 :size="11" class="shrink-0 text-ui-accent" aria-hidden="true" />
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
          class="composer-textarea w-full p-4 pb-2 bg-transparent border-none resize-none text-[15px] leading-relaxed placeholder:text-ui-text-muted/60 font-sans text-ui-text focus:outline-none min-h-[60px]"
          placeholder="/技能 @标签"
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
              class="composer-action-btn composer-stop-btn focus-visible:outline-none"
              aria-label="停止生成"
              @click="$emit('stop')"
            >
              <Square :size="14" fill="currentColor" aria-hidden="true" />
            </button>
            <button
              class="composer-action-btn composer-send-btn focus-visible:outline-none"
              :class="canSubmit ? 'composer-send-btn-ready' : 'composer-send-btn-disabled'"
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
.composer-shell {
  border: 1px solid color-mix(in oklab, var(--border) 92%, transparent);
  border-radius: 1rem;
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--surface) 92%, var(--bg) 8%) 0%,
    color-mix(in oklab, var(--surface) 96%, var(--bg) 4%) 100%
  );
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72), 0 10px 24px rgba(15, 23, 42, 0.06);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.composer-shell:focus-within {
  border-color: color-mix(in oklab, var(--accent) 48%, var(--border) 52%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.75),
    0 0 0 3px color-mix(in oklab, var(--accent) 20%, transparent),
    0 12px 30px rgba(15, 23, 42, 0.1);
}
.composer-textarea {
  transition: box-shadow 0.18s ease;
}
.composer-textarea:focus-visible {
  box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--accent) 34%, transparent);
  border-radius: 0.75rem;
}
.composer-action-btn {
  width: 2.25rem;
  height: 2.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  border: 1px solid transparent;
  transition: transform 0.14s ease, background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, color 0.18s ease;
}
.composer-action-btn:active {
  transform: translateY(1px) scale(0.98);
}
.composer-send-btn {
  color: #fff;
}
.composer-send-btn-ready {
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--accent) 82%, #fff 18%) 0%,
    color-mix(in oklab, var(--accent) 96%, #0f172a 4%) 100%
  );
  border-color: color-mix(in oklab, var(--accent) 55%, #0f172a 45%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.26), 0 8px 18px color-mix(in oklab, var(--accent) 32%, transparent);
}
.composer-send-btn-ready:hover {
  transform: translateY(-1px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 10px 22px color-mix(in oklab, var(--accent) 42%, transparent);
}
.composer-send-btn-disabled {
  background: color-mix(in oklab, var(--surface) 93%, var(--bg) 7%);
  color: color-mix(in oklab, var(--text-muted) 70%, transparent);
  border-color: color-mix(in oklab, var(--border) 94%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
}
.composer-send-btn:disabled {
  cursor: not-allowed;
  transform: none;
}
.composer-send-btn:disabled:hover {
  transform: none;
}
.composer-send-btn:focus-visible {
  box-shadow:
    0 0 0 3px color-mix(in oklab, var(--accent) 30%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.32);
}
.composer-stop-btn {
  color: #fff;
  background: linear-gradient(180deg, #ee7d6f 0%, #d95a4e 100%);
  border-color: color-mix(in oklab, #b03a2f 58%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 7px 16px rgba(217, 90, 78, 0.25);
}
.composer-stop-btn:hover {
  transform: translateY(-1px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 9px 20px rgba(217, 90, 78, 0.34);
}
.composer-stop-btn:focus-visible {
  box-shadow:
    0 0 0 3px rgba(217, 90, 78, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.24);
}
.custom-scrollbar::-webkit-scrollbar {
  width: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: var(--border);
  border-radius: 10px;
}
.shortcut-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.3em;
  padding: 0 0.35em;
  border: 1px solid color-mix(in oklab, var(--border) 85%, transparent);
  border-radius: 6px;
  background: color-mix(in oklab, var(--card) 92%, var(--bg) 8%);
  color: color-mix(in oklab, var(--text) 70%, transparent);
  font-size: 9px;
  line-height: 1.4;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
.shortcut-hint-item {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.shortcut-keys {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
}
.skill-row-disabled {
  opacity: 0.9;
}
</style>
