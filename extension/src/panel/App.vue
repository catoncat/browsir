<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, isRef, onMounted, ref } from "vue";
import { useRuntimeStore } from "./stores/runtime";
import { useChatStore } from "./stores/chat-store";
import type { ViewMode, SessionListRenderSessionItem } from "./types";

import ChatView from "./ChatView.vue";
import SessionList from "./components/SessionList.vue";
import SettingsView from "./components/SettingsView.vue";
import ProviderSettingsView from "./components/ProviderSettingsView.vue";
import McpSettingsView from "./components/McpSettingsView.vue";
import SkillsView from "./components/SkillsView.vue";
import PluginsView from "./components/PluginsView.vue";
import DebugView from "./components/DebugView.vue";

const store = useRuntimeStore();
const chatStore = useChatStore();
const { loading } = storeToRefs(store);

const activeView = ref<ViewMode>("chat");
const listOpen = ref(false);

const chatViewRef = ref<InstanceType<typeof ChatView> | null>(null);
const emptySessionListRenderState: {
  sessions: SessionListRenderSessionItem[];
  activeId: string;
} = {
  sessions: [],
  activeId: "",
};
const sessionListRenderState = computed(() => {
  const state = chatViewRef.value?.sessionListRenderState;
  if (!state) return emptySessionListRenderState;
  return isRef(state) ? state.value : state;
});

async function handleSelectSession(id: string) {
  try {
    await chatStore.loadConversation(id, { setActive: true });
    listOpen.value = false;
  } catch (err) {
    console.error("切换会话失败", err);
  }
}

async function handleDeleteSession(id: string) {
  try {
    await chatStore.deleteSession(id);
  } catch (err) {
    console.error("删除会话失败", err);
  }
}

async function handleUpdateSessionTitle(id: string, title: string) {
  try {
    await chatStore.updateSessionTitle(id, title);
  } catch (err) {
    console.error("重命名失败", err);
  }
}

onMounted(() => {
  void store.bootstrap().catch((err) => {
    console.error("初始化失败", err);
  });
});
</script>

<template>
  <div class="h-full min-h-0 flex flex-col bg-ui-bg text-ui-text font-sans selection:bg-ui-accent/10 border-none m-0 p-0 overflow-hidden">
    <SessionList
      v-if="listOpen"
      :is-open="listOpen"
      :sessions="sessionListRenderState.sessions"
      :active-id="sessionListRenderState.activeId"
      :loading="loading"
      @close="listOpen = false"
      @new="chatViewRef?.handleCreateSession()"
      @select="handleSelectSession"
      @delete="handleDeleteSession"
      @update-title="handleUpdateSessionTitle"
    />

    <SettingsView v-if="activeView === 'settings'" @close="activeView = 'chat'" />
    <ProviderSettingsView v-if="activeView === 'provider-settings'" @close="activeView = 'chat'" />
    <McpSettingsView v-if="activeView === 'mcp-settings'" @close="activeView = 'chat'" />
    <SkillsView v-if="activeView === 'skills'" @close="activeView = 'chat'" />
    <PluginsView v-if="activeView === 'plugins'" @close="activeView = 'chat'" />
    <DebugView v-if="activeView === 'debug'" @close="activeView = 'chat'" />

    <ChatView
      ref="chatViewRef"
      :list-open="listOpen"
      @update:active-view="activeView = $event"
      @update:list-open="listOpen = $event"
    />
  </div>
</template>
