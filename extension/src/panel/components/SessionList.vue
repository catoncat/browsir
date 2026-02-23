<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  Plus,
  Search,
  MessageSquare,
  Trash2,
  RefreshCcw,
  ArrowLeft,
  Clock
} from "lucide-vue-next";

interface Session {
  id: string;
  title?: string;
  updatedAt?: string;
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

function displayTitle(session: Session) {
  return session.title?.trim() || "新对话";
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
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2.5 hover:bg-ui-surface rounded-md text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="关闭会话列表"
        @click="$emit('close')"
      >
        <ArrowLeft :size="16" />
      </button>
      <h2 class="ml-1 text-[13px] font-bold text-ui-text tracking-tight uppercase opacity-90">对话历史</h2>

      <button
        class="ml-auto p-2.5 hover:bg-ui-surface rounded-md text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="新建会话"
        @click="$emit('new')"
      >
        <Plus :size="16" />
      </button>
    </header>

    <div class="px-3 py-2 border-b border-ui-border">
      <div class="relative group">
        <label :for="searchInputId" class="sr-only">搜索会话记录</label>
        <Search class="absolute left-2.5 top-2 text-ui-text" :size="14" />
        <input
          :id="searchInputId"
          v-model="searchQuery"
          type="text"
          placeholder="搜索会话记录..."
          aria-label="搜索会话记录"
          class="w-full pl-8 pr-3 py-1.5 bg-ui-surface border border-ui-border rounded-md text-[12px] text-ui-text transition-all placeholder:text-ui-text-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        />
      </div>
    </div>

    <nav class="flex-1 overflow-y-auto px-1.5 py-2 space-y-0.5 custom-scrollbar" aria-label="会话列表">
      <div
        v-for="session in filteredSessions"
        :key="session.id"
        class="group relative"
      >
        <button
          class="w-full flex items-start gap-2.5 px-3 py-2.5 rounded-md transition-all text-left relative overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
          :class="[
            activeId === session.id
              ? 'bg-ui-surface text-ui-text'
              : 'hover:bg-ui-surface/40'
          ]"
          @click="$emit('select', session.id)"
        >
          <div
            v-if="activeId === session.id"
            class="absolute left-0 top-2 bottom-2 w-0.5 bg-ui-accent rounded-r-full"
          ></div>

          <div class="mt-0.5 shrink-0" :class="activeId === session.id ? 'text-ui-accent' : 'text-ui-text-muted'">
            <MessageSquare :size="14" />
          </div>

          <div class="flex-1 min-w-0 pr-14">
            <div class="truncate text-[13px] leading-tight" :class="activeId === session.id ? 'font-semibold' : 'font-normal text-ui-text'">
              {{ displayTitle(session) }}
            </div>
            <div class="flex items-center gap-1 text-[10px] text-ui-text-muted font-medium mt-0.5">
              <Clock :size="10" />
              <span>{{ formatDate(session.updatedAt || "") }}</span>
            </div>
          </div>
        </button>

        <div class="absolute right-1.5 top-1/2 -translate-y-1/2 flex gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <button
            class="p-2 min-h-9 min-w-9 text-ui-text-muted hover:text-ui-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent rounded-md"
            aria-label="刷新标题"
            @click.stop="$emit('refresh', session.id)"
          >
            <RefreshCcw :size="13" />
          </button>
          <button
            class="p-2 min-h-9 min-w-9 text-ui-text-muted hover:text-red-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent rounded-md"
            aria-label="删除会话"
            @click.stop="$emit('delete', session.id)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
      </div>
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
