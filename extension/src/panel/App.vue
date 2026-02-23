<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from "vue";
import { useRuntimeStore } from "./stores/runtime";
import { useMessageActions } from "./utils/message-actions";

// Components
import SessionList from "./components/SessionList.vue";
import ChatMessage from "./components/ChatMessage.vue";
import ChatInput from "./components/ChatInput.vue";
import SettingsView from "./components/SettingsView.vue";
import DebugView from "./components/DebugView.vue";
import {
  Loader2,
  Plus,
  Settings,
  Bug,
  Activity,
  History
} from "lucide-vue-next";

const store = useRuntimeStore();
const { loading, error, sessions, activeSessionId, messages, runtime, health } = storeToRefs(store);

const prompt = ref("");
const scrollContainer = ref<HTMLElement | null>(null);
const listOpen = ref(false);
const showSettings = ref(false);
const showDebug = ref(false);

const isRunning = computed(() => Boolean(runtime.value?.running && !runtime.value?.stopped));
const hasBridge = computed(() => !!health.value.bridgeUrl);

const activeSessionTitle = computed(() => {
  const s = sessions.value.find((session) => session.id === activeSessionId.value);
  return s?.title || "新对话";
});

const {
  copiedEntryId,
  actionNotice,
  canCopyMessage,
  canRegenerateMessage,
  handleCopyMessage,
  handleRegenerateMessage,
  cleanupMessageActions
} = useMessageActions({
  messages,
  isRunning,
  regenerateFromAssistantEntry: store.regenerateFromAssistantEntry
});

// Auto-scroll
watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
    }
  },
  { deep: true }
);

onMounted(() => {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  void store.bootstrap();
});

const onRuntimeMessage = (message: any) => {
  if (message?.type !== "brain.event") return;
  const eventSessionId = String(message?.event?.sessionId || "").trim();
  if (!eventSessionId) return;
  void store.loadConversation(eventSessionId);
};

useIntervalFn(() => {
  if (!activeSessionId.value || isRunning.value) {
    void store.loadConversation(activeSessionId.value);
  }
}, 3000);

async function handleSend(payload: { text: string; tabIds: number[] }) {
  const { text, tabIds } = payload;
  if (!text.trim()) return;
  const isNew = !activeSessionId.value;
  prompt.value = "";
  // Passing text to sendPrompt. Store can be extended to handle tabIds metadata.
  await store.sendPrompt(text, { newSession: isNew });
}

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  cleanupMessageActions();
});
</script>

<template>
  <div class="fixed inset-0 flex flex-col bg-ui-bg text-ui-text font-sans selection:bg-ui-accent/10 border-none m-0 p-0 overflow-hidden">
    
    <!-- Session List Overlay -->
    <SessionList
      v-if="listOpen"
      :is-open="listOpen"
      :sessions="sessions"
      :active-id="activeSessionId"
      :loading="loading"
      @close="listOpen = false"
      @new="() => { store.createSession(); listOpen = false; }"
      @select="id => { store.loadConversation(id); listOpen = false; }"
      @delete="id => store.deleteSession(id)"
      @refresh="id => store.refreshSessionTitle(id)"
    />

    <SettingsView v-if="showSettings" @close="showSettings = false" />
    <DebugView v-if="showDebug" @close="showDebug = false" />

    <!-- Main View - Ensure min-h-0 to allow flex shrinking for scroll -->
    <main class="relative flex-1 flex flex-col min-w-0 min-h-0 bg-ui-bg">
      <div v-if="loading && !messages.length" class="absolute inset-0 z-40 flex items-center justify-center bg-white/80">
        <Loader2 class="animate-spin text-ui-accent" :size="24" />
      </div>

      <!-- High-Fidelity 48px Header -->
      <header class="h-12 flex items-center px-3 shrink-0 border-b border-ui-border bg-ui-bg z-30">
        <div class="flex-1 overflow-hidden flex items-center gap-2">
          <button @click="listOpen = true" class="p-2 -ml-1 hover:bg-ui-surface rounded-full text-ui-text transition-colors">
            <History :size="18" />
          </button>
          <h1 class="text-[15px] font-bold text-ui-text truncate tracking-tight">
            {{ activeSessionTitle }}
          </h1>
          <div v-if="hasBridge" class="w-2 h-2 bg-green-500 rounded-full shrink-0 shadow-[0_0_8px_rgba(34,197,94,0.4)]" title="Connected"></div>
        </div>

        <div class="flex items-center gap-1 shrink-0">
          <button 
            @click="() => store.createSession()" 
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors"
            title="新建对话"
          >
            <Plus :size="20" />
          </button>
          <button 
            @click="showDebug = true" 
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors"
            title="运行调试"
          >
            <Bug :size="18" />
          </button>
          <button 
            @click="showSettings = true" 
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors"
            title="系统设置"
          >
            <Settings :size="18" />
          </button>
        </div>
      </header>

      <!-- Chat Flow -->
      <div
        v-if="actionNotice"
        class="absolute top-14 left-1/2 z-30 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm"
        :class="actionNotice.type === 'success'
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-rose-50 text-rose-700 border-rose-200'"
      >
        {{ actionNotice.message }}
      </div>

      <div
        ref="scrollContainer"
        class="flex-1 overflow-y-auto scroll-smooth w-full min-h-0"
      >
        <div class="w-full px-5 pt-6 pb-8"> <!-- Reduced padding as it's no longer floating over -->
          <div v-if="messages.length" class="space-y-8">
            <ChatMessage
              v-for="(msg, index) in messages"
              :key="msg.entryId"
              :role="msg.role"
              :content="msg.content"
              :entry-id="msg.entryId"
              :copied="copiedEntryId === msg.entryId"
              :copy-disabled="loading || !canCopyMessage(msg)"
              :regenerate-disabled="loading || isRunning || !canRegenerateMessage(msg, index)"
              :show-copy-action="canCopyMessage(msg)"
              :show-regenerate-action="canRegenerateMessage(msg, index)"
              @copy="handleCopyMessage"
              @regenerate="handleRegenerateMessage"
            />
          </div>

          <!-- Solid Landing State -->
          <div v-else class="flex flex-col items-start py-8 animate-in fade-in duration-500">
             <div class="flex items-center gap-3 mb-4">
                <div class="w-10 h-10 bg-ui-accent/5 rounded-xl flex items-center justify-center border border-ui-accent/10">
                   <Activity :size="20" class="text-ui-accent" />
                </div>
                <h2 class="text-xl font-black uppercase tracking-tight text-ui-text">Agent Terminal</h2>
             </div>
             <p class="text-ui-text-muted text-[15px] leading-relaxed max-w-xs font-bold">
                系统就绪。发送指令开始自动化任务。CDP 与网桥协议已建立。
             </p>
          </div>
        </div>
      </div>

      <!-- Integrated Input Footer - Now part of the flex flow -->
      <div class="shrink-0 w-full bg-ui-bg border-t border-ui-border/30 z-20">
        <ChatInput
          v-model="prompt"
          :is-running="isRunning"
          :disabled="loading"
          @send="handleSend"
          @stop="() => store.runAction('brain.run.stop')"
        />
      </div>
    </main>
  </div>
</template>
