import { defineStore } from "pinia";
import { ref } from "vue";
import {
  normalizeBrowserRuntimeStrategy,
  type BrowserRuntimeStrategy,
} from "../../sw/kernel/browser-runtime-strategy";
import {
  normalizeCompactionSettings,
  type CompactionSettings,
} from "../../shared/compaction";
import { normalizeProviderConnectionConfig } from "../../shared/llm-provider-config";
import { sendMessage } from "./send-message";
import { toRecord, toIntInRange } from "./store-helpers";

export interface PanelLlmProfile {
  id: string;
  provider: string;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  providerOptions?: Record<string, unknown>;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
}

export interface PanelConfig {
  bridgeUrl: string;
  bridgeToken: string;
  browserRuntimeStrategy: BrowserRuntimeStrategy;
  compaction: CompactionSettings;
  llmDefaultProfile: string;
  llmAuxProfile: string;
  llmFallbackProfile: string;
  llmProfiles: PanelLlmProfile[];
  llmSystemPromptCustom: string;
  maxSteps: number;
  autoTitleInterval: number;
  bridgeInvokeTimeoutMs: number;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
  devAutoReload: boolean;
  devReloadIntervalMs: number;
}

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

export const DEFAULT_PANEL_LLM_PROVIDER = "openai_compatible";
export const DEFAULT_PANEL_LLM_API_BASE = "https://ai.chen.rs/v1";
export const DEFAULT_PANEL_LLM_MODEL = "gpt-5.3-codex";

interface LlmProfileDefaults {
  id: string;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
}

function createDefaultLlmProfile(
  defaults: LlmProfileDefaults,
): PanelLlmProfile {
  const id = String(defaults.id || "default").trim() || "default";
  return {
    id,
    provider: DEFAULT_PANEL_LLM_PROVIDER,
    llmApiBase: DEFAULT_PANEL_LLM_API_BASE,
    llmApiKey: "",
    llmModel: DEFAULT_PANEL_LLM_MODEL,
    providerOptions: {},
    llmTimeoutMs: defaults.llmTimeoutMs,
    llmRetryMaxAttempts: defaults.llmRetryMaxAttempts,
    llmMaxRetryDelayMs: defaults.llmMaxRetryDelayMs,
  };
}

function normalizeSingleLlmProfile(
  raw: Record<string, unknown>,
  defaults: LlmProfileDefaults,
): PanelLlmProfile {
  const base = createDefaultLlmProfile(defaults);
  const id = String(raw.id || base.id).trim() || base.id;
  const connection = normalizeProviderConnectionConfig({
    provider: raw.provider || base.provider,
    llmApiBase: raw.llmApiBase ?? base.llmApiBase,
    llmApiKey: raw.llmApiKey ?? base.llmApiKey,
  });
  return {
    id,
    provider: String(raw.provider || base.provider).trim() || base.provider,
    llmApiBase: connection.llmApiBase,
    llmApiKey: connection.llmApiKey,
    llmModel: String(raw.llmModel || base.llmModel).trim() || base.llmModel,
    providerOptions: toRecord(raw.providerOptions),
    llmTimeoutMs: toIntInRange(
      raw.llmTimeoutMs,
      defaults.llmTimeoutMs,
      1_000,
      300_000,
    ),
    llmRetryMaxAttempts: toIntInRange(
      raw.llmRetryMaxAttempts,
      defaults.llmRetryMaxAttempts,
      0,
      6,
    ),
    llmMaxRetryDelayMs: toIntInRange(
      raw.llmMaxRetryDelayMs,
      defaults.llmMaxRetryDelayMs,
      0,
      300_000,
    ),
  };
}

export function normalizeLlmProfiles(
  raw: unknown,
  defaults: LlmProfileDefaults,
): PanelLlmProfile[] {
  const out: PanelLlmProfile[] = [];
  const dedup = new Set<string>();

  const pushProfile = (value: unknown, idOverride?: string) => {
    const row = toRecord(value);
    const profile = normalizeSingleLlmProfile(row, {
      ...defaults,
      id: String(idOverride || defaults.id || "default").trim() || "default",
    });
    if (dedup.has(profile.id)) return;
    dedup.add(profile.id);
    out.push(profile);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) pushProfile(item);
  }

  if (out.length === 0) {
    out.push(createDefaultLlmProfile(defaults));
  }

  return out;
}

export function normalizeConfig(
  raw: Record<string, unknown> | null | undefined,
): PanelConfig {
  const bridgeUrl = String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws");
  const bridgeToken = String(raw?.bridgeToken || "");
  const llmTimeoutMs = toIntInRange(raw?.llmTimeoutMs, 120000, 1_000, 300_000);
  const llmRetryMaxAttempts = toIntInRange(raw?.llmRetryMaxAttempts, 2, 0, 6);
  const llmMaxRetryDelayMs = toIntInRange(
    raw?.llmMaxRetryDelayMs,
    60000,
    0,
    300_000,
  );
  const defaultProfile =
    String(raw?.llmDefaultProfile || "default").trim() || "default";

  const llmProfiles = normalizeLlmProfiles(raw?.llmProfiles, {
    id: defaultProfile,
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
  });
  const validProfileIds = new Set(llmProfiles.map((item) => item.id));
  const llmDefaultProfile = validProfileIds.has(defaultProfile)
    ? defaultProfile
    : llmProfiles[0]?.id || "default";
  const auxProfile = String(raw?.llmAuxProfile || "").trim();
  const fallbackProfile = String(raw?.llmFallbackProfile || "").trim();

  return {
    bridgeUrl,
    bridgeToken,
    browserRuntimeStrategy: normalizeBrowserRuntimeStrategy(
      raw?.browserRuntimeStrategy,
      "browser-first",
    ),
    compaction: normalizeCompactionSettings(raw?.compaction),
    llmDefaultProfile,
    llmAuxProfile:
      auxProfile &&
      auxProfile !== llmDefaultProfile &&
      validProfileIds.has(auxProfile)
        ? auxProfile
        : "",
    llmFallbackProfile:
      fallbackProfile &&
      fallbackProfile !== llmDefaultProfile &&
      validProfileIds.has(fallbackProfile)
        ? fallbackProfile
        : "",
    llmProfiles,
    llmSystemPromptCustom: String(raw?.llmSystemPromptCustom || ""),
    maxSteps: toIntInRange(raw?.maxSteps, 100, 1, 500),
    autoTitleInterval: toIntInRange(raw?.autoTitleInterval, 10, 0, 100),
    bridgeInvokeTimeoutMs: toIntInRange(
      raw?.bridgeInvokeTimeoutMs,
      120000,
      1_000,
      300_000,
    ),
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
    devAutoReload: raw?.devAutoReload === true,
    devReloadIntervalMs: toIntInRange(
      raw?.devReloadIntervalMs,
      1500,
      500,
      30000,
    ),
  };
}

function normalizeHealth(
  raw: Record<string, unknown> | null | undefined,
): RuntimeHealth {
  return {
    bridgeUrl: String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws"),
    llmDefaultProfile: String(raw?.llmDefaultProfile || "default"),
    llmAuxProfile: String(raw?.llmAuxProfile || ""),
    llmFallbackProfile: String(raw?.llmFallbackProfile || ""),
    llmProvider: String(raw?.llmProvider || DEFAULT_PANEL_LLM_PROVIDER),
    llmModel: String(raw?.llmModel || DEFAULT_PANEL_LLM_MODEL),
    hasLlmApiKey: Boolean(raw?.hasLlmApiKey),
    systemPromptPreview: String(raw?.systemPromptPreview || ""),
  };
}

export const useConfigStore = defineStore("config", () => {
  const savingConfig = ref(false);
  const error = ref("");
  const health = ref<RuntimeHealth>(
    normalizeHealth({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      llmDefaultProfile: "default",
      llmAuxProfile: "",
      llmFallbackProfile: "",
      llmProvider: DEFAULT_PANEL_LLM_PROVIDER,
      llmModel: DEFAULT_PANEL_LLM_MODEL,
      hasLlmApiKey: false,
    }),
  );
  const config = ref<PanelConfig>(
    normalizeConfig({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      llmDefaultProfile: "default",
      llmAuxProfile: "",
      llmFallbackProfile: "",
      compaction: normalizeCompactionSettings(undefined),
      llmSystemPromptCustom: "",
      autoTitleInterval: 10,
      bridgeInvokeTimeoutMs: 120000,
      llmTimeoutMs: 120000,
      llmRetryMaxAttempts: 2,
      llmMaxRetryDelayMs: 60000,
    }),
  );

  async function loadConfig(): Promise<void> {
    const cfg = await sendMessage<Record<string, unknown>>("config.get");
    config.value = normalizeConfig(cfg);
  }

  async function refreshHealth() {
    const raw =
      await sendMessage<Record<string, unknown>>("brain.debug.config");
    health.value = normalizeHealth(raw);
  }

  async function saveConfig() {
    savingConfig.value = true;
    error.value = "";
    try {
      const normalized = normalizeConfig(
        config.value as unknown as Record<string, unknown>,
      );
      config.value = normalized;

      await sendMessage("config.save", {
        payload: normalized,
      });
      await sendMessage("bridge.connect");
      await refreshHealth();
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
    savingConfig,
    error,
    loadConfig,
    refreshHealth,
    saveConfig,
  };
});
