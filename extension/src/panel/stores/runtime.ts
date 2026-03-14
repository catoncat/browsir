import { defineStore } from "pinia";
import { ref } from "vue";
import { useChatStore } from "./chat-store";
import { useConfigStore } from "./config-store";

export const useRuntimeStore = defineStore("runtime", () => {
  const chatStore = useChatStore();
  const configStore = useConfigStore();
  const loading = ref(false);

  async function bootstrap() {
    loading.value = true;
    configStore.error = "";
    try {
      await configStore.loadConfig();
      await Promise.all([configStore.refreshHealth(), chatStore.refreshSessions()]);
      if (!String(configStore.config.llmSystemPromptCustom || "").trim()) {
        const preview = String(configStore.health.systemPromptPreview || "");
        if (preview.trim()) {
          configStore.config.llmSystemPromptCustom = preview;
        }
      }
      if (chatStore.activeSessionId) {
        await chatStore.loadConversation(chatStore.activeSessionId, { setActive: false });
      }
    } catch (err) {
      configStore.error = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  return {
    loading,
    bootstrap,
  };
});
