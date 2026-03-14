import { defineStore } from "pinia";
import { ref } from "vue";
import { useChatStore } from "./chat-store";
import { useConfigStore } from "./config-store";
export type {
  ConversationMessage,
  SessionForkSource,
  SessionIndexEntry,
  RuntimeStateView,
} from "./chat-store";
export type {
  PanelConfig,
  PanelLlmProfile,
  RuntimeHealth,
} from "./config-store";
export {
  DEFAULT_PANEL_LLM_PROVIDER,
  DEFAULT_PANEL_LLM_API_BASE,
  DEFAULT_PANEL_LLM_MODEL,
} from "./config-store";
export type {
  SkillMetadata,
  SkillInstallInput,
  SkillDiscoverRoot,
  SkillDiscoverOptions,
  SkillDiscoverResult,
} from "./skill-store";
export type {
  PluginMetadata,
  PluginUiExtensionMetadata,
  PluginListResult,
  PluginRegisterResult,
  PluginUnregisterResult,
  PluginInstallInput,
  PluginValidateCheck,
  PluginValidateResult,
} from "./plugin-store";

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
