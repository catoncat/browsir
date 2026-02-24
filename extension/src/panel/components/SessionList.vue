<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  Plus,
  Search,
  MessageSquare,
  Trash2,
  RefreshCcw,
  ArrowLeft,
  Clock,
  GitBranch
} from "lucide-vue-next";

interface Session {
  id: string;
  title?: string;
  updatedAt?: string;
  parentSessionId?: string;
  forkedFrom?: {
    sessionId?: string;
    leafId?: string;
    sourceEntryId?: string;
    reason?: string;
  } | null;
}

const props = defineProps<{
  sessions: Session[];
  activeId: string;
  isOpen: boolean;
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "new"): void;
  (e: "delete", id: string): void;
  (e: "refresh", id: string): void;
  (e: "close"): void;
}>();

const searchQuery = ref("");
const dialogRef = ref<HTMLElement | null>(null);
const listRefs = ref<HTMLElement[]>([]);
const focusedIndex = ref(-1);
const searchInputId = "session-search-input";

const filteredSessions = computed(() => {
  const sorted = [...props.sessions].sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  );
  if (!searchQuery.value) return sorted;
  const q = searchQuery.value.toLowerCase();
  return sorted.filter(
    (session) => session.title?.toLowerCase().includes(q) || session.id.toLowerCase().includes(q)
  );
});

function handleKeydown(e: KeyboardEvent) {
  const total = filteredSessions.value.length;
  if (total === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusedIndex.value = (focusedIndex.value + 1) % total;
    scrollToFocused();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    focusedIndex.value = (focusedIndex.value - 1 + total) % total;
    scrollToFocused();
  } else if (e.key === "Enter" && focusedIndex.value >= 0) {
    const session = filteredSessions.value[focusedIndex.value];
    if (session) emit("select", session.id);
  }
}

function scrollToFocused() {
  const el = listRefs.value[focusedIndex.value];
  if (el) {
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  }
}

function displayTitle(session: Session) {
  return session.title?.trim() || "新对话";
}

function formatForkSource(session: Session) {
  const sourceId = String(session.forkedFrom?.sessionId || "").trim();
  if (!sourceId) return "";
  const tail = sourceId.length > 8 ? sourceId.slice(-8) : sourceId;
  return `来源 ${tail}`;
}

function formatDate(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

onMounted(() => {
  dialogRef.value?.focus();
});
</script>

<template>
  <div
    v-if="isOpen"
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="对话历史"
    class="fixed inset-0 z-50 bg-ui-bg flex flex-col transition-transform duration-200 ease-in-out focus:outline-none"
    :class="isOpen ? 'translate-x-0' : '-translate-x-full'"
    @keydown.esc="$emit('close')"
  >
    <header class="h-14 flex items-center px-3 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors"
        aria-label="关闭会话列表"
        @click="$emit('close')"
      >
        <ArrowLeft :size="20" />
      </button>
      <h2 class="ml-2 text-[16px] font-bold text-ui-text tracking-tight">对话历史</h2>

      <button
        class="ml-auto p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors"
        aria-label="新建会话"
        @click="$emit('new')"
      >
        <Plus :size="22" />
      </button>
    </header>

    <div class="px-4 py-3">
      <div class="relative group">
        <label :for="searchInputId" class="sr-only">搜索会话记录</label>
        <Search class="absolute left-3.5 top-2.5 text-ui-text-muted" :size="16" />
        <input
          :id="searchInputId"
          v-model="searchQuery"
          type="text"
          placeholder="搜索会话记录..."
          aria-label="搜索会话记录"
          class="w-full pl-10 pr-3 py-2 bg-ui-surface border border-ui-border/50 rounded-2xl text-[14px] text-ui-text transition-all placeholder:text-ui-text-muted/60 focus:outline-none focus:ring-1 focus:ring-ui-accent/30 focus:border-ui-accent/40"
          @keydown="handleKeydown"
        />
      </div>
    </div>

    <nav class="flex-1 overflow-y-auto px-3 py-2 custom-scrollbar" aria-label="会话列表">
      <ul role="list" class="space-y-1.5" @keydown="handleKeydown">
        <li
          v-for="(session, index) in filteredSessions"
          :key="session.id"
          class="group relative"
        >
          <button
            ref="listRefs"
            class="w-full flex items-start gap-3.5 px-4 py-3.5 rounded-2xl transition-all text-left relative overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            :class="[
              activeId === session.id
                ? 'bg-ui-surface border border-ui-border/60 shadow-sm'
                : 'hover:bg-ui-surface/50 border border-transparent'
            ]"
            :aria-current="activeId === session.id ? 'true' : 'false'"
            :aria-label="`选择会话: ${displayTitle(session)}`"
            @click="$emit('select', session.id)"
          >
            <div class="mt-0.5 shrink-0 flex items-center justify-center w-8 h-8 rounded-full" 
                 :class="activeId === session.id ? 'bg-ui-accent/10 text-ui-accent' : 'bg-ui-surface text-ui-text-muted'">
              <MessageSquare :size="16" aria-hidden="true" />
            </div>

            <div class="flex-1 min-w-0 pr-10">
              <div class="truncate text-[14px] leading-snug" :class="activeId === session.id ? 'font-bold text-ui-text' : 'font-medium text-ui-text/90'">
                {{ displayTitle(session) }}
              </div>
              
              <div class="flex items-center gap-3 mt-1.5">
                <div class="flex items-center gap-1 text-[11px] text-ui-text-muted">
                  <Clock :size="11" aria-hidden="true" />
                  <span :aria-label="`更新于 ${formatDate(session.updatedAt || '')}`">{{ formatDate(session.updatedAt || "") }}</span>
                </div>
                <div
                  v-if="session.forkedFrom?.sessionId"
                  class="flex items-center gap-1 text-[11px] text-ui-text-muted"
                >
                  <GitBranch :size="11" aria-hidden="true" />
                  <span :aria-label="`分叉自 ${formatForkSource(session)}`">{{ formatForkSource(session) }}</span>
                </div>
              </div>
            </div>
          </button>

          <!-- Actions hidden by default, shown on hover -->
          <div class="absolute right-3 top-1/2 -translate-y-1/2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-all duration-200 translate-x-1 group-hover:translate-x-0">
            <button
              class="p-2 text-ui-text-muted hover:text-ui-accent hover:bg-white rounded-lg shadow-sm border border-ui-border/50 bg-ui-bg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :aria-label="`刷新会话标题: ${displayTitle(session)}`"
              @click.stop="$emit('refresh', session.id)"
            >
              <RefreshCcw :size="14" aria-hidden="true" />
            </button>
            <button
              class="p-2 text-ui-text-muted hover:text-red-500 hover:bg-white rounded-lg shadow-sm border border-ui-border/50 bg-ui-bg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :aria-label="`删除会话: ${displayTitle(session)}`"
              @click.stop="$emit('delete', session.id)"
            >
              <Trash2 :size="14" aria-hidden="true" />
            </button>
          </div>
        </li>
      </ul>
    </nav>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: var(--border);
  border-radius: 10px;
}
</style>
