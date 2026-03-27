import { defineStore } from "pinia";
import { ref } from "vue";
import { resolveCursorHelpDisplayModel } from "../../shared/cursor-help-protocol";
import {
  BUILTIN_CURSOR_HELP_PROFILE_ID,
  DEFAULT_PANEL_LLM_API_BASE,
  DEFAULT_PANEL_LLM_MODEL,
  DEFAULT_PANEL_LLM_PROVIDER,
  createBuiltinCursorHelpProfileNew,
  createBuiltinCursorHelpProvider,
  createBuiltinOpenAiCompatibleProvider,
  normalizePanelConfig,
  type PanelConfigNew,
  type PanelLlmProfileNew,
  type PanelLlmProvider,
} from "../../shared/panel-config";
import { sendMessage } from "./send-message";
import { toRecord } from "./store-helpers";

export {
  BUILTIN_CURSOR_HELP_PROFILE_ID,
  DEFAULT_PANEL_LLM_API_BASE,
  DEFAULT_PANEL_LLM_MODEL,
  DEFAULT_PANEL_LLM_PROVIDER,
  createBuiltinCursorHelpProfileNew,
  createBuiltinCursorHelpProvider,
  createBuiltinOpenAiCompatibleProvider,
  normalizePanelConfig,
};

export type { PanelConfigNew, PanelLlmProfileNew, PanelLlmProvider };

export interface RuntimeHealth {
  bridgeUrl: string;
  llmDefaultProfile: string;
  llmAuxProfile: string;
  llmFallbackProfile: string;
  llmProvider: string;
  llmModel: string;
  hasLlmApiKey: boolean;
  systemPromptPreview: string;
}

export interface BuiltinFreeCatalog {
  selectedModel: string;
  availableModels: string[];
  statusMessage?: string;
  statusDetail?: string;
  checkedAt?: string;
  lastAction?: string;
}

function normalizeHealth(
  raw: Record<string, unknown> | null | undefined,
): RuntimeHealth {
  return {
    bridgeUrl: String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws"),
    llmDefaultProfile: String(raw?.llmDefaultProfile || ""),
    llmAuxProfile: String(raw?.llmAuxProfile || ""),
    llmFallbackProfile: String(raw?.llmFallbackProfile || ""),
    llmProvider: String(raw?.llmProvider || DEFAULT_PANEL_LLM_PROVIDER),
    llmModel: String(raw?.llmModel || DEFAULT_PANEL_LLM_MODEL),
    hasLlmApiKey: Boolean(raw?.hasLlmApiKey),
    systemPromptPreview: String(raw?.systemPromptPreview || ""),
  };
}

function normalizeBuiltinFreeCatalog(
  raw: Record<string, unknown> | null | undefined,
): BuiltinFreeCatalog {
  const seen = new Set<string>();
  const availableModels: string[] = [];
  const rawModels = Array.isArray(raw?.availableModels)
    ? raw?.availableModels
    : [];
  for (const item of rawModels) {
    const normalized = resolveCursorHelpDisplayModel(String(item || "").trim());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    availableModels.push(normalized);
  }
  return {
    selectedModel: resolveCursorHelpDisplayModel(
      String(raw?.selectedModel || "").trim(),
    ),
    availableModels,
    statusMessage: String(raw?.statusMessage || "").trim(),
    statusDetail: String(raw?.statusDetail || "").trim(),
    checkedAt: String(raw?.checkedAt || "").trim(),
    lastAction: String(raw?.lastAction || "").trim(),
  };
}

function createDefaultPanelConfig(): PanelConfigNew {
  return normalizePanelConfig({});
}

export const useConfigStore = defineStore("config", () => {
  const savingConfig = ref(false);
  const error = ref("");
  const health = ref<RuntimeHealth>(normalizeHealth(undefined));
  const builtinFreeCatalog = ref<BuiltinFreeCatalog>(
    normalizeBuiltinFreeCatalog(undefined),
  );
  const config = ref<PanelConfigNew>(createDefaultPanelConfig());

  async function loadConfig(): Promise<void> {
    const cfg = await sendMessage<Record<string, unknown>>("config.get");
    config.value = normalizePanelConfig(cfg);
  }

  async function refreshHealth(): Promise<void> {
    const raw = await sendMessage<Record<string, unknown>>("brain.debug.config");
    health.value = normalizeHealth(raw);
  }

  async function loadBuiltinFreeCatalog(options?: {
    forceRefresh?: boolean;
  }): Promise<void> {
    const raw = await sendMessage<Record<string, unknown>>(
      "brain.debug.model-catalog",
      options?.forceRefresh ? { forceRefresh: true } : {},
    );
    builtinFreeCatalog.value = normalizeBuiltinFreeCatalog(
      raw?.builtinFree && typeof raw.builtinFree === "object"
        ? (raw.builtinFree as Record<string, unknown>)
        : undefined,
    );
  }

  async function saveConfig(): Promise<void> {
    savingConfig.value = true;
    error.value = "";
    try {
      const normalized = normalizePanelConfig(toRecord(config.value));
      config.value = normalized;
      await sendMessage("config.save", { payload: normalized });
      try {
        await sendMessage("brain.mcp.sync-config", { refresh: true });
      } catch (syncError) {
        const reason =
          syncError instanceof Error ? syncError.message : String(syncError);
        const wrapped = new Error(`配置已保存，但运行时同步失败：${reason}`);
        error.value = wrapped.message;
        throw wrapped;
      } finally {
        await refreshHealth().catch(() => {});
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      savingConfig.value = false;
    }
  }

  return {
    config,
    health,
    builtinFreeCatalog,
    savingConfig,
    error,
    loadConfig,
    refreshHealth,
    loadBuiltinFreeCatalog,
    saveConfig,
  };
});
