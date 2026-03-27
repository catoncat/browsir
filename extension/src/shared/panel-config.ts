import {
  normalizeBrowserRuntimeStrategy,
  type BrowserRuntimeStrategy,
} from "../sw/kernel/browser-runtime-strategy";
import {
  normalizeCompactionSettings,
  type CompactionSettings,
} from "./compaction";
import {
  CURSOR_HELP_WEB_PROVIDER_ID,
  getProviderRuntimeKind,
  isCursorHelpWebProvider,
  normalizeProviderConnectionConfig,
  type ProviderRuntimeKind,
} from "./llm-provider-config";
import {
  normalizeMcpRefConfig,
  normalizeMcpServerList,
  type McpRefConfig,
  type McpServerConfig,
} from "./mcp-config";

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8787/ws";
const DEFAULT_LLM_TIMEOUT_MS = 120000;
const DEFAULT_LLM_RETRY_MAX_ATTEMPTS = 2;
const DEFAULT_LLM_MAX_RETRY_DELAY_MS = 60000;
const DEFAULT_MAX_STEPS = 100;
const DEFAULT_AUTO_TITLE_INTERVAL = 10;
const DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS = 120000;
const DEFAULT_DEV_RELOAD_INTERVAL_MS = 1500;

export const DEFAULT_PANEL_LLM_PROVIDER = "openai_compatible";
export const DEFAULT_PANEL_LLM_API_BASE = "";
export const DEFAULT_PANEL_LLM_MODEL = "auto";
export const BUILTIN_CURSOR_HELP_PROFILE_ID = CURSOR_HELP_WEB_PROVIDER_ID;

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

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
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

function toIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
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
    [CURSOR_HELP_WEB_PROVIDER_ID]: "内置模型",
    [DEFAULT_PANEL_LLM_PROVIDER]: "通用 API",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google AI",
    azure: "Azure OpenAI",
  };
  return nameMap[providerId] || providerId;
}

export function createBuiltinOpenAiCompatibleProvider(): PanelLlmProvider {
  return {
    id: DEFAULT_PANEL_LLM_PROVIDER,
    name: getProviderNameFromId(DEFAULT_PANEL_LLM_PROVIDER),
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
  if (providerId === DEFAULT_PANEL_LLM_PROVIDER) {
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

export function normalizePanelConfig(
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
      providerMap.set(
        normalized.providerId,
        createPlaceholderProvider(normalized.providerId),
      );
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
    mcpRefs: normalizeMcpRefConfig(raw?.mcpRefs),
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
