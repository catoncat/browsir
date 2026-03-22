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
import {
  CURSOR_HELP_WEB_PROVIDER_ID,
  getProviderRuntimeKind,
  isCursorHelpWebProvider,
  normalizeProviderConnectionConfig,
  providerRequiresApiConnection,
  type ProviderRuntimeKind,
} from "../../shared/llm-provider-config";
import {
  normalizeMcpRefConfig,
  normalizeMcpServerList,
  type McpRefConfig,
  type McpServerConfig,
} from "../../shared/mcp-config";
import { resolveCursorHelpDisplayModel } from "../../shared/cursor-help-protocol";
import { sendMessage } from "./send-message";
import { toIntInRange, toRecord } from "./store-helpers";

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8787/ws";
const DEFAULT_LLM_TIMEOUT_MS = 120000;
const DEFAULT_LLM_RETRY_MAX_ATTEMPTS = 2;
const DEFAULT_LLM_MAX_RETRY_DELAY_MS = 60000;
const DEFAULT_MAX_STEPS = 100;
const DEFAULT_AUTO_TITLE_INTERVAL = 10;
const DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS = 120000;
const DEFAULT_DEV_RELOAD_INTERVAL_MS = 1500;
const DEFAULT_OPENAI_PROVIDER_ID = "openai_compatible";
const PROFILE_OPTION_KEYS = new Set([
  "contextWindow",
  "maxOutputTokens",
  "temperature",
  "topP",
  "frequencyPenalty",
  "presencePenalty",
  "stop",
]);
const CURSOR_RUNTIME_OPTION_KEYS = new Set([
  "detectedModel",
  "availableModels",
  "lastSenderError",
  "senderKind",
  "pageHookReady",
  "fetchHookReady",
  "senderReady",
  "canExecute",
  "url",
]);

export const DEFAULT_PANEL_LLM_PROVIDER = DEFAULT_OPENAI_PROVIDER_ID;
export const DEFAULT_PANEL_LLM_API_BASE = "";
export const DEFAULT_PANEL_LLM_MODEL = "auto";
export const BUILTIN_CURSOR_HELP_PROFILE_ID = CURSOR_HELP_WEB_PROVIDER_ID;

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
  mcpServers: McpServerConfig[];
  mcpRefs: McpRefConfig;
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

export interface BuiltinFreeCatalog {
  selectedModel: string;
  availableModels: string[];
  statusMessage?: string;
  statusDetail?: string;
  checkedAt?: string;
  lastAction?: string;
}

export interface PanelLlmProvider {
  id: string;
  name: string;
  type: ProviderRuntimeKind;
  apiConfig?: {
    apiBase: string;
    apiKey: string;
    defaultModel?: string;
    supportedModels?: string[];
    supportsModelDiscovery?: boolean;
  };
  options?: Record<string, unknown>;
  builtin: boolean;
}

export interface PanelLlmProfileNew {
  id: string;
  providerId: string;
  modelId: string;
  timeoutMs: number;
  retryMaxAttempts: number;
  maxRetryDelayMs: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  builtin: boolean;
}

export interface PanelConfigNew {
  bridgeUrl: string;
  bridgeToken: string;
  mcpServers: McpServerConfig[];
  mcpRefs: McpRefConfig;
  browserRuntimeStrategy: BrowserRuntimeStrategy;
  compaction: CompactionSettings;
  llmProviders: PanelLlmProvider[];
  llmProfiles: PanelLlmProfileNew[];
  llmDefaultProfile: string;
  llmAuxProfile: string;
  llmFallbackProfile: string;
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

interface LlmProfileDefaults {
  id: string;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
}

function normalizeId(raw: unknown, fallback: string): string {
  const value = String(raw || "").trim();
  return value || fallback;
}

function createUniqueId(seed: string, taken: Set<string>): string {
  const base = normalizeId(seed, "item");
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

function toOptionalNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function toStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeStop(raw: unknown): string[] | undefined {
  const out = toStringList(raw);
  return out.length > 0 ? out : undefined;
}

function getProviderNameFromId(providerId: string): string {
  const nameMap: Record<string, string> = {
    [CURSOR_HELP_WEB_PROVIDER_ID]: "Cursor 宿主聊天",
    [DEFAULT_OPENAI_PROVIDER_ID]: "通用 API",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google AI",
    azure: "Azure OpenAI",
  };
  return nameMap[providerId] || providerId;
}

function createBuiltinOpenAiCompatibleProvider(): PanelLlmProvider {
  return {
    id: DEFAULT_OPENAI_PROVIDER_ID,
    name: getProviderNameFromId(DEFAULT_OPENAI_PROVIDER_ID),
    type: "model_llm",
    apiConfig: {
      apiBase: DEFAULT_PANEL_LLM_API_BASE,
      apiKey: "",
      supportedModels: [],
      supportsModelDiscovery: false,
    },
    options: {},
    builtin: true,
  };
}

export function createBuiltinCursorHelpProvider(): PanelLlmProvider {
  return {
    id: CURSOR_HELP_WEB_PROVIDER_ID,
    name: getProviderNameFromId(CURSOR_HELP_WEB_PROVIDER_ID),
    type: "hosted_chat",
    options: {
      targetSite: "cursor_help",
    },
    builtin: true,
  };
}

export function createBuiltinCursorHelpProfile(
  defaults?: Partial<LlmProfileDefaults>,
): PanelLlmProfile {
  return {
    id: BUILTIN_CURSOR_HELP_PROFILE_ID,
    provider: CURSOR_HELP_WEB_PROVIDER_ID,
    llmApiBase: "",
    llmApiKey: "",
    llmModel: DEFAULT_PANEL_LLM_MODEL,
    providerOptions: {
      targetSite: "cursor_help",
    },
    llmTimeoutMs: defaults?.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    llmRetryMaxAttempts: defaults?.llmRetryMaxAttempts ?? 1,
    llmMaxRetryDelayMs: defaults?.llmMaxRetryDelayMs ?? DEFAULT_LLM_MAX_RETRY_DELAY_MS,
  };
}

export function createBuiltinCursorHelpProfileNew(
  defaults?: Partial<{
    timeoutMs: number;
    retryMaxAttempts: number;
    maxRetryDelayMs: number;
  }>,
): PanelLlmProfileNew {
  return {
    id: BUILTIN_CURSOR_HELP_PROFILE_ID,
    providerId: CURSOR_HELP_WEB_PROVIDER_ID,
    modelId: DEFAULT_PANEL_LLM_MODEL,
    timeoutMs: defaults?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    retryMaxAttempts: defaults?.retryMaxAttempts ?? 1,
    maxRetryDelayMs:
      defaults?.maxRetryDelayMs ?? DEFAULT_LLM_MAX_RETRY_DELAY_MS,
    builtin: true,
  };
}

function createDefaultLlmProfile(defaults: LlmProfileDefaults): PanelLlmProfile {
  return createBuiltinCursorHelpProfile(defaults);
}

function normalizeSingleLlmProfile(
  raw: Record<string, unknown>,
  defaults: LlmProfileDefaults,
): PanelLlmProfile {
  const base = createDefaultLlmProfile(defaults);
  const provider = normalizeId(raw.provider, base.provider);
  const connection = normalizeProviderConnectionConfig({
    provider,
    llmApiBase: raw.llmApiBase ?? base.llmApiBase,
    llmApiKey: raw.llmApiKey ?? base.llmApiKey,
  });
  return {
    id: normalizeId(raw.id, base.id),
    provider,
    llmApiBase: connection.llmApiBase,
    llmApiKey: connection.llmApiKey,
    llmModel: normalizeId(raw.llmModel, base.llmModel),
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

function normalizeLlmProfiles(
  raw: unknown,
  defaults: LlmProfileDefaults,
): PanelLlmProfile[] {
  const out: PanelLlmProfile[] = [];
  const dedup = new Set<string>();

  const pushProfile = (value: unknown, idOverride?: string) => {
    const row = toRecord(value);
    const profile = normalizeSingleLlmProfile(row, {
      ...defaults,
      id: normalizeId(idOverride, defaults.id),
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

function normalizeLegacyConfig(
  raw: Record<string, unknown> | null | undefined,
): PanelConfig {
  const bridgeUrl = String(raw?.bridgeUrl || DEFAULT_BRIDGE_URL);
  const bridgeToken = String(raw?.bridgeToken || "");
  const llmTimeoutMs = toIntInRange(
    raw?.llmTimeoutMs,
    DEFAULT_LLM_TIMEOUT_MS,
    1_000,
    300_000,
  );
  const llmRetryMaxAttempts = toIntInRange(
    raw?.llmRetryMaxAttempts,
    DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    0,
    6,
  );
  const llmMaxRetryDelayMs = toIntInRange(
    raw?.llmMaxRetryDelayMs,
    DEFAULT_LLM_MAX_RETRY_DELAY_MS,
    0,
    300_000,
  );
  const defaultProfile = normalizeId(
    raw?.llmDefaultProfile,
    BUILTIN_CURSOR_HELP_PROFILE_ID,
  );
  const llmProfiles = normalizeLlmProfiles(raw?.llmProfiles, {
    id: defaultProfile,
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
  });

  if (!llmProfiles.some((item) => item.id === BUILTIN_CURSOR_HELP_PROFILE_ID)) {
    llmProfiles.push(
      createBuiltinCursorHelpProfile({
        llmTimeoutMs,
        llmRetryMaxAttempts: 1,
        llmMaxRetryDelayMs,
      }),
    );
  }

  const validProfileIds = new Set(llmProfiles.map((item) => item.id));
  const llmDefaultProfile = validProfileIds.has(defaultProfile)
    ? defaultProfile
    : llmProfiles[0]?.id || BUILTIN_CURSOR_HELP_PROFILE_ID;
  const auxProfile = String(raw?.llmAuxProfile || "").trim();
  const fallbackProfile = String(raw?.llmFallbackProfile || "").trim();

  return {
    bridgeUrl,
    bridgeToken,
    mcpServers: normalizeMcpServerList(raw?.mcpServers),
    mcpRefs: normalizeMcpRefConfig(raw?.mcpRefs),
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
    maxSteps: toIntInRange(raw?.maxSteps, DEFAULT_MAX_STEPS, 1, 500),
    autoTitleInterval: toIntInRange(
      raw?.autoTitleInterval,
      DEFAULT_AUTO_TITLE_INTERVAL,
      0,
      100,
    ),
    bridgeInvokeTimeoutMs: toIntInRange(
      raw?.bridgeInvokeTimeoutMs,
      DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS,
      1_000,
      300_000,
    ),
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
    devAutoReload: raw?.devAutoReload === true,
    devReloadIntervalMs: toIntInRange(
      raw?.devReloadIntervalMs,
      DEFAULT_DEV_RELOAD_INTERVAL_MS,
      500,
      30_000,
    ),
  };
}

function splitLegacyProviderOptions(
  raw: Record<string, unknown> | undefined,
): {
  providerOptions: Record<string, unknown>;
  profileOptions: Record<string, unknown>;
} {
  const input = toRecord(raw);
  const providerOptions: Record<string, unknown> = {};
  const profileOptions: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (CURSOR_RUNTIME_OPTION_KEYS.has(key)) continue;
    if (PROFILE_OPTION_KEYS.has(key)) {
      profileOptions[key] = value;
      continue;
    }
    providerOptions[key] = value;
  }

  return { providerOptions, profileOptions };
}

function buildLegacyProviderSignature(profile: PanelLlmProfile): string {
  const providerId = normalizeId(profile.provider, DEFAULT_PANEL_LLM_PROVIDER);
  const connection = normalizeProviderConnectionConfig({
    provider: providerId,
    llmApiBase: profile.llmApiBase,
    llmApiKey: profile.llmApiKey,
  });
  const split = splitLegacyProviderOptions(profile.providerOptions);
  return JSON.stringify({
    providerId,
    type: getProviderRuntimeKind(providerId),
    apiBase: connection.llmApiBase,
    apiKey: connection.llmApiKey,
    options: split.providerOptions,
  });
}

export function migrateLegacyProfile(
  legacy: PanelLlmProfile,
  providerId?: string,
): {
  provider: PanelLlmProvider;
  profile: PanelLlmProfileNew;
} {
  const normalizedLegacy = normalizeSingleLlmProfile(toRecord(legacy), {
    id: normalizeId(legacy.id, "profile"),
    llmTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    llmRetryMaxAttempts: DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    llmMaxRetryDelayMs: DEFAULT_LLM_MAX_RETRY_DELAY_MS,
  });
  const normalizedProviderId = normalizeId(
    providerId,
    normalizedLegacy.provider || DEFAULT_PANEL_LLM_PROVIDER,
  );
  const split = splitLegacyProviderOptions(normalizedLegacy.providerOptions);
  const runtimeKind = getProviderRuntimeKind(normalizedLegacy.provider);
  const connection = normalizeProviderConnectionConfig({
    provider: normalizedLegacy.provider,
    llmApiBase: normalizedLegacy.llmApiBase,
    llmApiKey: normalizedLegacy.llmApiKey,
  });

  const provider: PanelLlmProvider = {
    id: normalizedProviderId,
    name: getProviderNameFromId(normalizedLegacy.provider),
    type: runtimeKind,
    apiConfig:
      runtimeKind === "model_llm"
        ? {
            apiBase: connection.llmApiBase,
            apiKey: connection.llmApiKey,
            defaultModel: normalizeId(
              normalizedLegacy.llmModel,
              DEFAULT_PANEL_LLM_MODEL,
            ),
            supportedModels: toStringList([normalizedLegacy.llmModel]),
            supportsModelDiscovery: false,
          }
        : undefined,
    options:
      runtimeKind === "hosted_chat"
        ? {
            targetSite: "cursor_help",
            ...split.providerOptions,
          }
        : split.providerOptions,
    builtin: normalizedProviderId === CURSOR_HELP_WEB_PROVIDER_ID,
  };

  const profile: PanelLlmProfileNew = {
    id: normalizeId(normalizedLegacy.id, "profile"),
    providerId: normalizedProviderId,
    modelId: normalizeId(
      normalizedLegacy.llmModel,
      runtimeKind === "hosted_chat" ? DEFAULT_PANEL_LLM_MODEL : "",
    ),
    timeoutMs: normalizedLegacy.llmTimeoutMs,
    retryMaxAttempts: normalizedLegacy.llmRetryMaxAttempts,
    maxRetryDelayMs: normalizedLegacy.llmMaxRetryDelayMs,
    contextWindow: toOptionalNumber(split.profileOptions.contextWindow),
    maxOutputTokens: toOptionalNumber(split.profileOptions.maxOutputTokens),
    temperature: toOptionalNumber(split.profileOptions.temperature),
    topP: toOptionalNumber(split.profileOptions.topP),
    frequencyPenalty: toOptionalNumber(split.profileOptions.frequencyPenalty),
    presencePenalty: toOptionalNumber(split.profileOptions.presencePenalty),
    stop: normalizeStop(split.profileOptions.stop),
    builtin: normalizeId(normalizedLegacy.id, "") === BUILTIN_CURSOR_HELP_PROFILE_ID,
  };

  return { provider, profile };
}

export function isLegacyConfig(raw: unknown): boolean {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (Array.isArray(config.llmProviders)) return false;
  if (Array.isArray(config.llmProfiles)) {
    const firstProfile = config.llmProfiles[0];
    if (firstProfile && typeof firstProfile === "object") {
      const profile = firstProfile as Record<string, unknown>;
      return "llmApiBase" in profile || "llmApiKey" in profile || "provider" in profile;
    }
    return true;
  }
  return true;
}

function ensureBuiltinProviders(providers: PanelLlmProvider[]): PanelLlmProvider[] {
  const map = new Map<string, PanelLlmProvider>();
  for (const provider of providers) {
    map.set(provider.id, provider);
  }

  const cursor = map.get(CURSOR_HELP_WEB_PROVIDER_ID);
  map.set(CURSOR_HELP_WEB_PROVIDER_ID, {
    ...createBuiltinCursorHelpProvider(),
    ...cursor,
    id: CURSOR_HELP_WEB_PROVIDER_ID,
    name: cursor?.name || getProviderNameFromId(CURSOR_HELP_WEB_PROVIDER_ID),
    type: "hosted_chat",
    apiConfig: undefined,
    options: {
      targetSite: "cursor_help",
      ...toRecord(cursor?.options),
    },
    builtin: true,
  });

  return Array.from(map.values());
}

export function migrateLegacyConfig(
  raw: Record<string, unknown> | PanelConfig | null | undefined,
): PanelConfigNew {
  const legacyConfig = normalizeLegacyConfig(toRecord(raw));
  const providers: PanelLlmProvider[] = [];
  const profiles: PanelLlmProfileNew[] = [];
  const signatureToProviderId = new Map<string, string>();
  const takenProviderIds = new Set<string>();
  const takenProfileIds = new Set<string>();

  for (const legacyProfile of legacyConfig.llmProfiles) {
    const baseProviderId = normalizeId(
      legacyProfile.provider,
      DEFAULT_PANEL_LLM_PROVIDER,
    );
    const signature = buildLegacyProviderSignature(legacyProfile);
    let providerId = signatureToProviderId.get(signature);
    if (!providerId) {
      providerId =
        baseProviderId === CURSOR_HELP_WEB_PROVIDER_ID
          ? CURSOR_HELP_WEB_PROVIDER_ID
          : createUniqueId(baseProviderId, takenProviderIds);
      signatureToProviderId.set(signature, providerId);
    }
    const migrated = migrateLegacyProfile(legacyProfile, providerId);
    if (!providers.some((item) => item.id === migrated.provider.id)) {
      providers.push(migrated.provider);
    }
    const nextProfileId =
      migrated.profile.id === BUILTIN_CURSOR_HELP_PROFILE_ID
        ? BUILTIN_CURSOR_HELP_PROFILE_ID
        : createUniqueId(migrated.profile.id, takenProfileIds);
    profiles.push({
      ...migrated.profile,
      id: nextProfileId,
      builtin: nextProfileId === BUILTIN_CURSOR_HELP_PROFILE_ID,
    });
  }

  const normalized = normalizeNewConfig({
    ...legacyConfig,
    llmProviders: providers,
    llmProfiles: profiles,
  });

  return {
    ...normalized,
    llmDefaultProfile: normalized.llmProfiles.some(
      (item) => item.id === legacyConfig.llmDefaultProfile,
    )
      ? legacyConfig.llmDefaultProfile
      : normalized.llmDefaultProfile,
    llmAuxProfile: normalized.llmProfiles.some(
      (item) => item.id === legacyConfig.llmAuxProfile,
    )
      ? legacyConfig.llmAuxProfile
      : normalized.llmAuxProfile,
    llmFallbackProfile: normalized.llmProfiles.some(
      (item) => item.id === legacyConfig.llmFallbackProfile,
    )
      ? legacyConfig.llmFallbackProfile
      : normalized.llmFallbackProfile,
  };
}

function normalizeProvider(
  raw: unknown,
  fallbackId: string,
): PanelLlmProvider {
  const row = toRecord(raw);
  const id = normalizeId(row.id, fallbackId);
  const type =
    row.type === "model_llm" || row.type === "hosted_chat"
      ? (row.type as ProviderRuntimeKind)
      : getProviderRuntimeKind(id);
  const apiConfig = toRecord(row.apiConfig);
  const connection = normalizeProviderConnectionConfig({
    provider: id,
    llmApiBase: apiConfig.apiBase,
    llmApiKey: apiConfig.apiKey,
  });

  return {
    id,
    name: normalizeId(row.name, getProviderNameFromId(id)),
    type,
    apiConfig:
      type === "model_llm"
        ? {
            apiBase: connection.llmApiBase,
            apiKey: connection.llmApiKey,
            defaultModel: String(apiConfig.defaultModel || "").trim() || undefined,
            supportedModels: toStringList(apiConfig.supportedModels),
            supportsModelDiscovery: apiConfig.supportsModelDiscovery === true,
          }
        : undefined,
    options:
      id === CURSOR_HELP_WEB_PROVIDER_ID
        ? {
            targetSite: "cursor_help",
            ...toRecord(row.options),
          }
        : toRecord(row.options),
    builtin: row.builtin === true || id === CURSOR_HELP_WEB_PROVIDER_ID,
  };
}

function createPlaceholderProvider(providerId: string): PanelLlmProvider {
  if (providerId === CURSOR_HELP_WEB_PROVIDER_ID) {
    return createBuiltinCursorHelpProvider();
  }
  if (providerId === DEFAULT_OPENAI_PROVIDER_ID) {
    return createBuiltinOpenAiCompatibleProvider();
  }
  const type = getProviderRuntimeKind(providerId);
  return {
    id: providerId,
    name: getProviderNameFromId(providerId),
    type,
    apiConfig:
      type === "model_llm"
        ? {
            apiBase: "",
            apiKey: "",
            supportedModels: [],
            supportsModelDiscovery: false,
          }
        : undefined,
    options:
      type === "hosted_chat"
        ? {
            targetSite: "cursor_help",
          }
        : {},
    builtin: false,
  };
}

function normalizeProfile(
  raw: unknown,
  fallbackId: string,
  configDefaults: {
    timeoutMs: number;
    retryMaxAttempts: number;
    maxRetryDelayMs: number;
  },
): PanelLlmProfileNew {
  const row = toRecord(raw);
  const providerId = normalizeId(row.providerId, DEFAULT_PANEL_LLM_PROVIDER);
  const hosted = isCursorHelpWebProvider(providerId);
  const rawId = normalizeId(row.id, fallbackId);
  const id =
    hosted && (row.builtin === true || rawId === "built-in")
      ? BUILTIN_CURSOR_HELP_PROFILE_ID
      : rawId;

  return {
    id,
    providerId,
    modelId: normalizeId(
      row.modelId,
      hosted ? DEFAULT_PANEL_LLM_MODEL : "",
    ),
    timeoutMs: toIntInRange(
      row.timeoutMs,
      configDefaults.timeoutMs,
      1_000,
      300_000,
    ),
    retryMaxAttempts: toIntInRange(
      row.retryMaxAttempts,
      configDefaults.retryMaxAttempts,
      0,
      6,
    ),
    maxRetryDelayMs: toIntInRange(
      row.maxRetryDelayMs,
      configDefaults.maxRetryDelayMs,
      0,
      300_000,
    ),
    contextWindow: toOptionalNumber(row.contextWindow),
    maxOutputTokens: toOptionalNumber(row.maxOutputTokens),
    temperature: toOptionalNumber(row.temperature),
    topP: toOptionalNumber(row.topP),
    frequencyPenalty: toOptionalNumber(row.frequencyPenalty),
    presencePenalty: toOptionalNumber(row.presencePenalty),
    stop: normalizeStop(row.stop),
    builtin:
      row.builtin === true || normalizeId(row.id, "") === BUILTIN_CURSOR_HELP_PROFILE_ID,
  };
}

export function normalizeNewConfig(
  raw: Record<string, unknown> | null | undefined,
): PanelConfigNew {
  const bridgeUrl = String(raw?.bridgeUrl || DEFAULT_BRIDGE_URL);
  const bridgeToken = String(raw?.bridgeToken || "");
  const llmTimeoutMs = toIntInRange(
    raw?.llmTimeoutMs,
    DEFAULT_LLM_TIMEOUT_MS,
    1_000,
    300_000,
  );
  const llmRetryMaxAttempts = toIntInRange(
    raw?.llmRetryMaxAttempts,
    DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    0,
    6,
  );
  const llmMaxRetryDelayMs = toIntInRange(
    raw?.llmMaxRetryDelayMs,
    DEFAULT_LLM_MAX_RETRY_DELAY_MS,
    0,
    300_000,
  );

  const providerRows = Array.isArray(raw?.llmProviders) ? raw?.llmProviders : [];
  const providerMap = new Map<string, PanelLlmProvider>();
  for (const item of providerRows) {
    const normalized = normalizeProvider(item, `provider-${providerMap.size + 1}`);
    providerMap.set(normalized.id, normalized);
  }

  const profileRows = Array.isArray(raw?.llmProfiles) ? raw?.llmProfiles : [];
  const profiles: PanelLlmProfileNew[] = [];
  const takenProfileIds = new Set<string>();
  const profileIdAliases = new Map<string, string>();
  for (const item of profileRows) {
    const row = toRecord(item);
    const sourceId = normalizeId(row.id, `profile-${profiles.length + 1}`);
    const normalized = normalizeProfile(item, `profile-${profiles.length + 1}`, {
      timeoutMs: llmTimeoutMs,
      retryMaxAttempts: llmRetryMaxAttempts,
      maxRetryDelayMs: llmMaxRetryDelayMs,
    });
    const id =
      normalized.id === BUILTIN_CURSOR_HELP_PROFILE_ID
        ? BUILTIN_CURSOR_HELP_PROFILE_ID
        : createUniqueId(normalized.id, takenProfileIds);
    profileIdAliases.set(sourceId, id);
    const nextProfile = {
      ...normalized,
      id,
      builtin: id === BUILTIN_CURSOR_HELP_PROFILE_ID || normalized.builtin,
    };
    const existingIndex = profiles.findIndex((item) => item.id === id);
    if (existingIndex >= 0) {
      profiles[existingIndex] = {
        ...profiles[existingIndex],
        ...nextProfile,
        builtin: id === BUILTIN_CURSOR_HELP_PROFILE_ID || nextProfile.builtin,
      };
    } else {
      profiles.push(nextProfile);
    }
    if (!providerMap.has(normalized.providerId)) {
      providerMap.set(normalized.providerId, createPlaceholderProvider(normalized.providerId));
    }
  }

  if (!profiles.some((item) => item.id === BUILTIN_CURSOR_HELP_PROFILE_ID)) {
    profiles.push(
      createBuiltinCursorHelpProfileNew({
        timeoutMs: llmTimeoutMs,
        maxRetryDelayMs: llmMaxRetryDelayMs,
      }),
    );
  }

  const llmProviders = ensureBuiltinProviders(Array.from(providerMap.values()));
  const validProviderIds = new Set(llmProviders.map((item) => item.id));
  const repairedProfiles = profiles.map((item) => {
    if (validProviderIds.has(item.providerId)) return item;
    return {
      ...item,
      providerId: DEFAULT_PANEL_LLM_PROVIDER,
    };
  });
  const validProfileIds = new Set(repairedProfiles.map((item) => item.id));
  const remapProfileId = (value: unknown): string => {
    const id = normalizeId(value, "");
    return profileIdAliases.get(id) || id;
  };
  const builtinDefaultProfile = validProfileIds.has(BUILTIN_CURSOR_HELP_PROFILE_ID)
    ? BUILTIN_CURSOR_HELP_PROFILE_ID
    : repairedProfiles[0]?.id || BUILTIN_CURSOR_HELP_PROFILE_ID;
  const requestedDefaultProfile = remapProfileId(raw?.llmDefaultProfile);
  const llmDefaultProfile =
    requestedDefaultProfile && validProfileIds.has(requestedDefaultProfile)
      ? requestedDefaultProfile
      : builtinDefaultProfile;
  const auxProfile = remapProfileId(raw?.llmAuxProfile);
  const fallbackProfile = remapProfileId(raw?.llmFallbackProfile);

  return {
    bridgeUrl,
    bridgeToken,
    mcpServers: normalizeMcpServerList(raw?.mcpServers),
    browserRuntimeStrategy: normalizeBrowserRuntimeStrategy(
      raw?.browserRuntimeStrategy,
      "browser-first",
    ),
    compaction: normalizeCompactionSettings(raw?.compaction),
    llmProviders,
    llmProfiles: repairedProfiles,
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
    llmSystemPromptCustom: String(raw?.llmSystemPromptCustom || ""),
    maxSteps: toIntInRange(raw?.maxSteps, DEFAULT_MAX_STEPS, 1, 500),
    autoTitleInterval: toIntInRange(
      raw?.autoTitleInterval,
      DEFAULT_AUTO_TITLE_INTERVAL,
      0,
      100,
    ),
    bridgeInvokeTimeoutMs: toIntInRange(
      raw?.bridgeInvokeTimeoutMs,
      DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS,
      1_000,
      300_000,
    ),
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
    devAutoReload: raw?.devAutoReload === true,
    devReloadIntervalMs: toIntInRange(
      raw?.devReloadIntervalMs,
      DEFAULT_DEV_RELOAD_INTERVAL_MS,
      500,
      30_000,
    ),
  };
}

export function normalizePanelConfig(
  raw: Record<string, unknown> | null | undefined,
): PanelConfigNew {
  return isLegacyConfig(raw)
    ? migrateLegacyConfig(raw)
    : normalizeNewConfig(raw);
}

export function convertToLegacyBridgeConfig(
  newConfig: PanelConfigNew,
): PanelConfig {
  const providersById = new Map(
    newConfig.llmProviders.map((item) => [item.id, item] as const),
  );
  const referencedProfileIds = new Set(
    [
      newConfig.llmDefaultProfile,
      newConfig.llmAuxProfile,
      newConfig.llmFallbackProfile,
    ]
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  );

  const legacyProfiles: PanelLlmProfile[] = newConfig.llmProfiles
    .filter(
      (item) =>
        item.id !== BUILTIN_CURSOR_HELP_PROFILE_ID ||
        referencedProfileIds.has(item.id),
    )
    .map((profile) => {
      const provider = providersById.get(profile.providerId);
      if (!provider) {
        throw new Error(`Provider '${profile.providerId}' not found`);
      }
      const connection = normalizeProviderConnectionConfig({
        provider: provider.id,
        llmApiBase: provider.apiConfig?.apiBase,
        llmApiKey: provider.apiConfig?.apiKey,
      });

      return {
        id: profile.id,
        provider: provider.id,
        llmApiBase: connection.llmApiBase,
        llmApiKey: connection.llmApiKey,
        llmModel: normalizeId(
          profile.modelId,
          isCursorHelpWebProvider(provider.id) ? DEFAULT_PANEL_LLM_MODEL : "",
        ),
        providerOptions: {
          ...toRecord(provider.options),
          ...(profile.contextWindow !== undefined
            ? { contextWindow: profile.contextWindow }
            : {}),
          ...(profile.maxOutputTokens !== undefined
            ? { maxOutputTokens: profile.maxOutputTokens }
            : {}),
          ...(profile.temperature !== undefined
            ? { temperature: profile.temperature }
            : {}),
          ...(profile.topP !== undefined ? { topP: profile.topP } : {}),
          ...(profile.frequencyPenalty !== undefined
            ? { frequencyPenalty: profile.frequencyPenalty }
            : {}),
          ...(profile.presencePenalty !== undefined
            ? { presencePenalty: profile.presencePenalty }
            : {}),
          ...(profile.stop?.length ? { stop: profile.stop } : {}),
        },
        llmTimeoutMs: profile.timeoutMs,
        llmRetryMaxAttempts: profile.retryMaxAttempts,
        llmMaxRetryDelayMs: profile.maxRetryDelayMs,
      };
    });

  return {
    bridgeUrl: newConfig.bridgeUrl,
    bridgeToken: newConfig.bridgeToken,
    mcpServers: normalizeMcpServerList(newConfig.mcpServers),
    mcpRefs: normalizeMcpRefConfig(newConfig.mcpRefs),
    browserRuntimeStrategy: newConfig.browserRuntimeStrategy,
    compaction: newConfig.compaction,
    llmDefaultProfile: newConfig.llmDefaultProfile,
    llmAuxProfile: newConfig.llmAuxProfile,
    llmFallbackProfile: newConfig.llmFallbackProfile,
    llmProfiles: legacyProfiles,
    llmSystemPromptCustom: newConfig.llmSystemPromptCustom,
    maxSteps: newConfig.maxSteps,
    autoTitleInterval: newConfig.autoTitleInterval,
    bridgeInvokeTimeoutMs: newConfig.bridgeInvokeTimeoutMs,
    llmTimeoutMs: newConfig.llmTimeoutMs,
    llmRetryMaxAttempts: newConfig.llmRetryMaxAttempts,
    llmMaxRetryDelayMs: newConfig.llmMaxRetryDelayMs,
    devAutoReload: newConfig.devAutoReload,
    devReloadIntervalMs: newConfig.devReloadIntervalMs,
  };
}

function normalizeHealth(
  raw: Record<string, unknown> | null | undefined,
): RuntimeHealth {
  return {
    bridgeUrl: String(raw?.bridgeUrl || DEFAULT_BRIDGE_URL),
    llmDefaultProfile: String(raw?.llmDefaultProfile || ""),
    llmAuxProfile: String(raw?.llmAuxProfile || ""),
    llmFallbackProfile: String(raw?.llmFallbackProfile || ""),
    llmProvider: String(raw?.llmProvider || CURSOR_HELP_WEB_PROVIDER_ID),
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
  for (const item of toStringList(raw?.availableModels)) {
    const normalized = resolveCursorHelpDisplayModel(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    availableModels.push(normalized);
  }
  return {
    selectedModel: resolveCursorHelpDisplayModel(String(raw?.selectedModel || "").trim()),
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
      const payload = convertToLegacyBridgeConfig(normalized);
      await sendMessage("config.save", { payload });
      try {
        await sendMessage("bridge.connect");
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
