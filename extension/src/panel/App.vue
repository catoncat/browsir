<script setup lang="ts">
import { useIntervalFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, nextTick, watch } from "vue";
import { useRuntimeStore } from "./stores/runtime";
import { useMessageActions, type PanelMessageLike } from "./utils/message-actions";

import SessionList from "./components/SessionList.vue";
import ChatMessage from "./components/ChatMessage.vue";
import ChatInput from "./components/ChatInput.vue";
import SettingsView from "./components/SettingsView.vue";
import DebugView from "./components/DebugView.vue";
import { Loader2, Plus, Settings, Bug, Activity, History, MoreVertical, FileUp, Download, ExternalLink, Copy } from "lucide-vue-next";
import { onClickOutside } from "@vueuse/core";

const store = useRuntimeStore();
const { loading, error, sessions, activeSessionId, messages, runtime, health } = storeToRefs(store);

const prompt = ref("");
const scrollContainer = ref<HTMLElement | null>(null);
const listOpen = ref(false);
const showSettings = ref(false);
const showDebug = ref(false);
const showMoreMenu = ref(false);
const showExportMenu = ref(false);
const moreMenuRef = ref(null);
const exportMenuRef = ref(null);

onClickOutside(moreMenuRef, () => showMoreMenu.value = false);
onClickOutside(exportMenuRef, () => showExportMenu.value = false);

const isRunning = computed(() => Boolean(runtime.value?.running && !runtime.value?.stopped));
const hasBridge = computed(() => Boolean(health.value.bridgeUrl));
const activeSession = computed(() => sessions.value.find((item) => item.id === activeSessionId.value) || null);

const activeSessionTitle = computed(() => {
  const session = activeSession.value;
  return session?.title || "新对话";
});

const activeForkSourceText = computed(() => {
  const sourceId = String(activeSession.value?.forkedFrom?.sessionId || "").trim();
  if (!sourceId) return "";
  const tail = sourceId.length > 8 ? sourceId.slice(-8) : sourceId;
  return `分叉自 ${tail}`;
});

interface DisplayMessage extends PanelMessageLike {
  role: string;
  content: string;
  entryId: string;
  busyPlaceholder?: boolean;
  busyMode?: "retry" | "fork";
  busySourceEntryId?: string;
}

const {
  copiedEntryId,
  retryingEntryId,
  forkingEntryId,
  pendingRegenerate,
  actionNotice,
  canCopyMessage,
  canRetryMessage,
  canForkMessage,
  handleCopyMessage,
  handleRetryMessage,
  handleForkMessage,
  cleanupMessageActions
} = useMessageActions({
  messages,
  isRunning,
  regenerateFromAssistantEntry: store.regenerateFromAssistantEntry
});

const displayMessages = computed<DisplayMessage[]>(() => {
  const base = (messages.value || []).map((item) => ({
    role: String(item?.role || ""),
    content: String(item?.content || ""),
    entryId: String(item?.entryId || "")
  }));
  const pending = pendingRegenerate.value;
  if (!pending) return base;

  const placeholder: DisplayMessage = {
    role: "assistant_placeholder",
    content: "正在重新生成回复…",
    entryId: `__regen_placeholder__${pending.mode}__${pending.sourceEntryId}`,
    busyPlaceholder: true,
    busyMode: pending.mode,
    busySourceEntryId: pending.sourceEntryId
  };

  if (pending.mode === "retry") {
    const targetIndex = base.findIndex(
      (item) => item.role === "assistant" && item.entryId === pending.sourceEntryId
    );
    if (targetIndex >= 0) {
      base.splice(targetIndex, 1, placeholder);
      return base;
    }
  }

  const anchorIndex = base.findIndex((item) => item.entryId === pending.insertAfterUserEntryId);
  if (anchorIndex >= 0) {
    base.splice(anchorIndex + 1, 0, placeholder);
    return base;
  }
  base.push(placeholder);
  return base;
});

watch(
  () => displayMessages.value.length,
  async () => {
    await nextTick();
    if (scrollContainer.value) {
      scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight;
    }
  },
  { deep: true }
);

function setErrorMessage(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err || "");
  error.value = message || fallback;
}

async function runSafely(task: () => Promise<void>, fallback: string) {
  try {
    await task();
  } catch (err) {
    setErrorMessage(err, fallback);
    console.error(err);
  }
}

const onRuntimeMessage = (message: unknown) => {
  const payload = message as { type?: string; event?: { sessionId?: string } };
  if (payload?.type !== "brain.event") return;
  const eventSessionId = String(payload?.event?.sessionId || "").trim();
  if (!eventSessionId) return;

  if (eventSessionId === activeSessionId.value) {
    void runSafely(
      () => store.loadConversation(eventSessionId, { setActive: false }),
      "刷新会话失败"
    );
    return;
  }

  void runSafely(() => store.refreshSessions(), "刷新会话列表失败");
};

onMounted(() => {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  void runSafely(() => store.bootstrap(), "初始化失败");
});

useIntervalFn(() => {
  if (!activeSessionId.value || !isRunning.value) return;
  void runSafely(
    () => store.loadConversation(activeSessionId.value, { setActive: false }),
    "轮询会话失败"
  );
}, 3000);

async function handleCreateSession() {
  await runSafely(async () => {
    await store.createSession();
    listOpen.value = false;
  }, "新建会话失败");
}

async function handleSelectSession(id: string) {
  await runSafely(async () => {
    await store.loadConversation(id, { setActive: true });
    listOpen.value = false;
  }, "切换会话失败");
}

async function handleDeleteSession(id: string) {
  await runSafely(() => store.deleteSession(id), "删除会话失败");
}

async function handleRefreshSession(id: string) {
  await runSafely(() => store.refreshSessionTitle(id), "刷新标题失败");
}

async function handleStopRun() {
  await runSafely(() => store.runAction("brain.run.stop"), "停止任务失败");
}

async function handleSend(payload: { text: string; tabIds: number[] }) {
  const text = String(payload.text || "");
  if (!text.trim()) return;
  const isNew = !activeSessionId.value;

  try {
    await store.sendPrompt(text, {
      newSession: isNew,
      tabIds: Array.isArray(payload.tabIds) ? payload.tabIds : []
    });
    prompt.value = "";
  } catch (err) {
    setErrorMessage(err, "发送失败");
  }
}

function generateMarkdown() {
  const title = activeSessionTitle.value;
  let md = `# ${title}\n\n`;
  
  messages.value.forEach(msg => {
    if (msg.role === 'user') {
      md += `**User**: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      // 简单过滤，只保留文本对话内容
      const content = msg.content.trim();
      if (content) {
        md += `**Assistant**: ${content}\n\n`;
      }
    }
  });
  
  return md;
}

async function handleCopyMarkdown() {
  const md = generateMarkdown();
  try {
    await navigator.clipboard.writeText(md);
    actionNotice.value = { type: 'success', message: '已复制到剪贴板' };
    setTimeout(() => { actionNotice.value = null; }, 2000);
  } catch (err) {
    setErrorMessage(err, '复制失败');
  }
  showExportMenu.value = false;
}

function handleExport(mode: 'download' | 'open') {
  const md = generateMarkdown();
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  if (mode === 'download') {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSessionTitle.value.replace(/\s+/g, '_')}.md`;
    a.click();
    // 下载后延迟释放，确保浏览器完成操作
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else {
    // 使用 text/markdown MIME 类型的 Blob URL。
    // 很多 Markdown Viewer 插件会拦截此 MIME 类型的 blob 链接。
    // 我们不立即调用 revokeObjectURL，给新标签页留出加载时间。
    chrome.tabs.create({ url });
    // 10秒后自动释放，防止内存泄露，但也足够插件加载了
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  
  showExportMenu.value = false;
}

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  cleanupMessageActions();
});
</script>

<template>
  <div class="h-full min-h-0 flex flex-col bg-ui-bg text-ui-text font-sans selection:bg-ui-accent/10 border-none m-0 p-0 overflow-hidden">
    <SessionList
      v-if="listOpen"
      :is-open="listOpen"
      :sessions="sessions"
      :active-id="activeSessionId"
      :loading="loading"
      @close="listOpen = false"
      @new="handleCreateSession"
      @select="handleSelectSession"
      @delete="handleDeleteSession"
      @refresh="handleRefreshSession"
    />

    <SettingsView v-if="showSettings" @close="showSettings = false" />
    <DebugView v-if="showDebug" @close="showDebug = false" />

    <main class="relative flex-1 flex flex-col min-w-0 min-h-0 bg-ui-bg">
      <div v-if="loading && !displayMessages.length" class="absolute inset-0 z-40 flex items-center justify-center bg-white/80">
        <Loader2 class="animate-spin text-ui-accent" :size="24" />
      </div>

      <header class="h-12 flex items-center px-3 shrink-0 border-b border-ui-border bg-ui-bg z-30" role="banner">
        <div class="flex-1 overflow-hidden flex items-center gap-2">
          <h1 class="text-[15px] font-bold text-ui-text truncate tracking-tight ml-1">
            {{ activeSessionTitle }}
          </h1>
          <span v-if="activeForkSourceText" class="text-[10px] font-semibold text-ui-text-muted uppercase tracking-wide">
            {{ activeForkSourceText }}
          </span>
          <div v-if="hasBridge" class="w-2 h-2 bg-green-500 rounded-full shrink-0 shadow-[0_0_8px_rgba(34,197,94,0.4)]" :title="'Bridge Connected'" role="status" aria-label="Bridge Connected"></div>
        </div>

        <div class="flex items-center gap-0.5 shrink-0" role="toolbar" aria-label="会话操作">
          <button
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            title="会话历史"
            aria-label="查看会话历史列表"
            @click="listOpen = true"
          >
            <History :size="18" aria-hidden="true" />
          </button>
          
          <button
            class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            title="新建对话"
            aria-label="开始新对话"
            @click="handleCreateSession"
          >
            <Plus :size="20" aria-hidden="true" />
          </button>

          <!-- Export Menu -->
          <div class="relative" ref="exportMenuRef">
            <button
              class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              title="导出对话"
              :aria-label="showExportMenu ? '关闭导出菜单' : '打开导出菜单'"
              aria-haspopup="menu"
              :aria-expanded="showExportMenu"
              @click="showExportMenu = !showExportMenu"
            >
              <FileUp :size="18" aria-hidden="true" />
            </button>
            <div 
              v-if="showExportMenu" 
              class="absolute right-0 mt-1 w-44 bg-ui-bg border border-ui-border rounded-lg shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100"
              role="menu"
            >
              <button role="menuitem" @click="handleCopyMarkdown" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
                <Copy :size="14" aria-hidden="true" /> 复制 Markdown
              </button>
              <button role="menuitem" @click="handleExport('download')" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left border-t border-ui-border/30 focus:bg-ui-surface outline-none">
                <Download :size="14" aria-hidden="true" /> 下载 MD 文件
              </button>
              <button role="menuitem" @click="handleExport('open')" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
                <ExternalLink :size="14" aria-hidden="true" /> 在标签页打开
              </button>
            </div>
          </div>

          <!-- More Menu -->
          <div class="relative" ref="moreMenuRef">
            <button
              class="p-2 hover:bg-ui-surface rounded-full text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              title="更多选项"
              :aria-label="showMoreMenu ? '关闭更多菜单' : '打开更多菜单'"
              aria-haspopup="menu"
              :aria-expanded="showMoreMenu"
              @click="showMoreMenu = !showMoreMenu"
            >
              <MoreVertical :size="18" aria-hidden="true" />
            </button>
            <div 
              v-if="showMoreMenu" 
              class="absolute right-0 mt-1 w-32 bg-ui-bg border border-ui-border rounded-lg shadow-xl z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100"
              role="menu"
            >
              <button role="menuitem" @click="showDebug = true; showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
                <Bug :size="14" aria-hidden="true" /> 运行调试
              </button>
              <button role="menuitem" @click="showSettings = true; showMoreMenu = false" class="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-ui-surface text-left focus:bg-ui-surface outline-none">
                <Settings :size="14" aria-hidden="true" /> 系统设置
              </button>
            </div>
          </div>
        </div>
      </header>

      <div
        v-if="actionNotice"
        role="alert"
        aria-live="polite"
        class="absolute top-14 left-1/2 z-30 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm"
        :class="actionNotice.type === 'success'
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-rose-50 text-rose-700 border-rose-200'"
      >
        {{ actionNotice.message }}
      </div>

      <div
        v-if="error"
        role="alert"
        class="absolute top-24 left-1/2 z-30 -translate-x-1/2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 shadow-sm"
      >
        {{ error }}
      </div>

      <div
        ref="scrollContainer"
        class="flex-1 overflow-y-auto scroll-smooth w-full min-h-0"
        role="log"
        aria-live="polite"
        aria-label="对话历史记录"
      >
        <div class="w-full px-5 pt-6 pb-8">
          <div v-if="displayMessages.length" class="space-y-8" role="list">
            <ChatMessage
              v-for="(msg, index) in displayMessages"
              :key="msg.entryId"
              :role="msg.role"
              :content="msg.content"
              :entry-id="msg.entryId"
              :busy-placeholder="msg.busyPlaceholder"
              :busy-mode="msg.busyMode"
              :busy-source-entry-id="msg.busySourceEntryId"
              :copied="copiedEntryId === msg.entryId"
              :retrying="retryingEntryId === msg.entryId"
              :forking="forkingEntryId === msg.entryId"
              :copy-disabled="loading || !canCopyMessage(msg)"
              :retry-disabled="loading || isRunning || !canRetryMessage(msg, index)"
              :fork-disabled="loading || isRunning || !canForkMessage(msg, index)"
              :show-copy-action="canCopyMessage(msg)"
              :show-retry-action="canRetryMessage(msg, index)"
              :show-fork-action="canForkMessage(msg, index)"
              @copy="handleCopyMessage"
              @retry="handleRetryMessage"
              @fork="handleForkMessage"
            />
          </div>

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

      <div class="shrink-0 w-full bg-ui-bg z-20">
        <ChatInput
          v-model="prompt"
          :is-running="isRunning"
          :disabled="loading"
          @send="handleSend"
          @stop="handleStopRun"
        />
      </div>
    </main>
  </div>
</template>
