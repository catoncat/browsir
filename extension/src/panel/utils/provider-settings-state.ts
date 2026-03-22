import {
  BUILTIN_CURSOR_HELP_PROFILE_ID,
  DEFAULT_PANEL_LLM_PROVIDER,
  type PanelConfigNew,
  type PanelLlmProfileNew,
  type PanelLlmProvider,
} from "../stores/config-store";
import { resolveCursorHelpDisplayModel } from "../../shared/cursor-help-protocol";

export interface ProviderSettingsDraft {
  primaryModelId: string;
  auxModelId: string;
  fallbackModelId: string;
}

type ManagedRole = "primary" | "aux" | "fallback";

export const ADD_CUSTOM_PROVIDER_OPTION_VALUE = "__add_custom_provider__";
export const BUILTIN_FREE_PROVIDER_LABEL = "内置免费";

export interface BuiltinFreeModelCatalog {
  selectedModel: string;
  availableModels: string[];
}

export interface SceneModelOption {
  value: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
}

export interface SceneModelDraft {
  primaryValue: string;
  auxValue: string;
  fallbackValue: string;
}

export interface CustomProviderDraft {
  providerName: string;
  apiBase: string;
  apiKey: string;
  supportedModels: string[];
}

export interface CustomProviderSummary {
  id: string;
  name: string;
  apiBase: string;
  selectedModels: string[];
  selectedModelCount: number;
}

function trim(value: unknown): string {
  return String(value || "").trim();
}

function isBuiltinCursorProfile(
  profile: PanelLlmProfileNew | null | undefined,
): boolean {
  return trim(profile?.id) === BUILTIN_CURSOR_HELP_PROFILE_ID;
}

function isManagedProfile(
  profile: PanelLlmProfileNew | null | undefined,
): profile is PanelLlmProfileNew {
  return Boolean(profile) && !isBuiltinCursorProfile(profile);
}

function findProfile(
  config: PanelConfigNew,
  profileId: string,
): PanelLlmProfileNew | null {
  const id = trim(profileId);
  if (!id) return null;
  return config.llmProfiles.find((item) => trim(item.id) === id) || null;
}

function findProvider(
  config: PanelConfigNew,
  providerId: string,
): PanelLlmProvider | null {
  const id = trim(providerId);
  if (!id) return null;
  return config.llmProviders.find((item) => trim(item.id) === id) || null;
}

function ensureProvider(
  config: PanelConfigNew,
  providerId: string,
): PanelLlmProvider {
  const existing = findProvider(config, providerId);
  if (existing) return existing;

  const provider: PanelLlmProvider = {
    id: trim(providerId) || DEFAULT_PANEL_LLM_PROVIDER,
    name: "通用 API",
    type: "model_llm",
    apiConfig: {
      apiBase: "",
      apiKey: "",
      supportedModels: [],
      supportsModelDiscovery: false,
    },
    options: {},
    builtin: providerId === DEFAULT_PANEL_LLM_PROVIDER,
  };
  config.llmProviders.push(provider);
  return provider;
}

function createUniqueProfileId(config: PanelConfigNew, seed: string): string {
  const base = trim(seed) || "profile";
  const taken = new Set(config.llmProfiles.map((item) => trim(item.id)));
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createManagedProfile(
  config: PanelConfigNew,
  seed: string,
  providerId: string,
  modelId: string,
): PanelLlmProfileNew {
  const profile: PanelLlmProfileNew = {
    id: createUniqueProfileId(config, seed),
    providerId,
    modelId,
    timeoutMs: config.llmTimeoutMs,
    retryMaxAttempts: config.llmRetryMaxAttempts,
    maxRetryDelayMs: config.llmMaxRetryDelayMs,
    builtin: false,
  };
  config.llmProfiles.push(profile);
  return profile;
}

function ensureSceneRoleProfile(
  config: PanelConfigNew,
  role: ManagedRole,
  preferredProfileId: string,
  providerId: string,
  modelId: string,
): PanelLlmProfileNew {
  const preferred = findProfile(config, preferredProfileId);
  if (preferred) {
    preferred.providerId = providerId;
    preferred.modelId = modelId;
    return preferred;
  }

  const existingBySeed = findProfile(config, `route-${role}`);
  if (existingBySeed) {
    existingBySeed.providerId = providerId;
    existingBySeed.modelId = modelId;
    return existingBySeed;
  }

  return createManagedProfile(config, `route-${role}`, providerId, modelId);
}

function ensureManagedRoleProfile(
  config: PanelConfigNew,
  role: ManagedRole,
  preferredProfileId: string,
  providerId: string,
  modelId: string,
): PanelLlmProfileNew {
  const preferred = findProfile(config, preferredProfileId);
  if (isManagedProfile(preferred)) {
    preferred.providerId = providerId;
    preferred.modelId = modelId;
    return preferred;
  }

  const existingBySeed = findProfile(config, `custom-${role}`);
  if (isManagedProfile(existingBySeed)) {
    existingBySeed.providerId = providerId;
    existingBySeed.modelId = modelId;
    return existingBySeed;
  }

  return createManagedProfile(config, `custom-${role}`, providerId, modelId);
}

function appendUnique(out: string[], seen: Set<string>, value: unknown): void {
  const normalized = trim(value);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  out.push(normalized);
}

export function deriveManagedProviderId(config: PanelConfigNew): string {
  const selectedProfiles = [
    findProfile(config, config.llmDefaultProfile),
    findProfile(config, config.llmAuxProfile),
    findProfile(config, config.llmFallbackProfile),
  ];

  for (const profile of selectedProfiles) {
    if (isManagedProfile(profile)) {
      return trim(profile.providerId) || DEFAULT_PANEL_LLM_PROVIDER;
    }
  }

  const firstManagedProfile = config.llmProfiles.find((item) => isManagedProfile(item));
  if (firstManagedProfile) {
    return trim(firstManagedProfile.providerId) || DEFAULT_PANEL_LLM_PROVIDER;
  }

  const builtinProvider = findProvider(config, DEFAULT_PANEL_LLM_PROVIDER);
  if (builtinProvider) return builtinProvider.id;

  const firstModelProvider = config.llmProviders.find(
    (item) => item.type === "model_llm",
  );
  return trim(firstModelProvider?.id) || DEFAULT_PANEL_LLM_PROVIDER;
}

export function collectProviderModelOptions(
  config: PanelConfigNew,
  providerId = deriveManagedProviderId(config),
): string[] {
  const provider = findProvider(config, providerId);
  const out: string[] = [];
  const seen = new Set<string>();

  appendUnique(out, seen, provider?.apiConfig?.defaultModel);
  for (const modelId of provider?.apiConfig?.supportedModels || []) {
    appendUnique(out, seen, modelId);
  }
  for (const profile of config.llmProfiles) {
    if (trim(profile.providerId) !== trim(providerId)) continue;
    if (isBuiltinCursorProfile(profile)) continue;
    appendUnique(out, seen, profile.modelId);
  }

  return out;
}

export function deriveProviderSettingsDraft(
  config: PanelConfigNew,
  providerId = deriveManagedProviderId(config),
): ProviderSettingsDraft {
  const provider = findProvider(config, providerId);
  const modelOptions = collectProviderModelOptions(config, providerId);
  const defaultProfile = findProfile(config, config.llmDefaultProfile);
  const primaryProfile =
    isManagedProfile(defaultProfile) && trim(defaultProfile.providerId) === trim(providerId)
      ? defaultProfile
      : config.llmProfiles.find(
          (item) =>
            isManagedProfile(item) && trim(item.providerId) === trim(providerId),
        ) || null;
  const auxProfile = findProfile(config, config.llmAuxProfile);
  const fallbackProfile = findProfile(config, config.llmFallbackProfile);

  return {
    primaryModelId:
      trim(primaryProfile?.modelId) ||
      trim(provider?.apiConfig?.defaultModel) ||
      modelOptions[0] ||
      "",
    auxModelId:
      isManagedProfile(auxProfile) && trim(auxProfile.providerId) === trim(providerId)
        ? trim(auxProfile.modelId)
        : "",
    fallbackModelId:
      isManagedProfile(fallbackProfile) &&
      trim(fallbackProfile.providerId) === trim(providerId)
        ? trim(fallbackProfile.modelId)
        : "",
  };
}

export function resetToBuiltinCursor(config: PanelConfigNew): void {
  config.llmDefaultProfile = BUILTIN_CURSOR_HELP_PROFILE_ID;
  config.llmAuxProfile = "";
  config.llmFallbackProfile = "";
}

export function applyProviderSettingsDraft(
  config: PanelConfigNew,
  draft: ProviderSettingsDraft,
  providerId = deriveManagedProviderId(config),
): void {
  const normalizedProviderId = trim(providerId) || DEFAULT_PANEL_LLM_PROVIDER;
  const primaryModelId = trim(draft.primaryModelId);
  const auxModelId = trim(draft.auxModelId);
  const fallbackModelId = trim(draft.fallbackModelId);

  if (!primaryModelId) {
    resetToBuiltinCursor(config);
    return;
  }

  const provider = ensureProvider(config, normalizedProviderId);
  if (!provider.apiConfig) {
    provider.apiConfig = {
      apiBase: "",
      apiKey: "",
      supportedModels: [],
      supportsModelDiscovery: false,
    };
  }
  provider.apiConfig.defaultModel = primaryModelId;
  const supportedModels = collectProviderModelOptions(config, normalizedProviderId);
  appendUnique(supportedModels, new Set(supportedModels), primaryModelId);
  appendUnique(supportedModels, new Set(supportedModels), auxModelId);
  appendUnique(supportedModels, new Set(supportedModels), fallbackModelId);
  provider.apiConfig.supportedModels = supportedModels;

  const primaryProfile = ensureManagedRoleProfile(
    config,
    "primary",
    config.llmDefaultProfile,
    normalizedProviderId,
    primaryModelId,
  );
  config.llmDefaultProfile = primaryProfile.id;

  if (!auxModelId || auxModelId === primaryModelId) {
    config.llmAuxProfile = "";
  } else {
    const auxProfile = ensureManagedRoleProfile(
      config,
      "aux",
      config.llmAuxProfile,
      normalizedProviderId,
      auxModelId,
    );
    config.llmAuxProfile = auxProfile.id;
  }

  if (!fallbackModelId || fallbackModelId === primaryModelId) {
    config.llmFallbackProfile = "";
  } else {
    const fallbackProfile = ensureManagedRoleProfile(
      config,
      "fallback",
      config.llmFallbackProfile,
      normalizedProviderId,
      fallbackModelId,
    );
    config.llmFallbackProfile = fallbackProfile.id;
  }
}

function collectProviderAssignedModels(
  config: PanelConfigNew,
  providerId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const profile of config.llmProfiles) {
    if (trim(profile.providerId) !== trim(providerId)) continue;
    appendUnique(out, seen, profile.modelId);
  }
  return out;
}

function createCustomProviderId(config: PanelConfigNew, providerName: string): string {
  const normalized = trim(providerName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = normalized || "provider";
  const taken = new Set(config.llmProviders.map((item) => trim(item.id)));
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function collectCustomProviderModels(
  config: PanelConfigNew,
  provider: PanelLlmProvider,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  appendUnique(out, seen, provider.apiConfig?.defaultModel);
  for (const model of provider.apiConfig?.supportedModels || []) {
    appendUnique(out, seen, model);
  }
  for (const model of collectProviderAssignedModels(config, provider.id)) {
    appendUnique(out, seen, model);
  }
  return out;
}

function collectExplicitProviderModels(provider: PanelLlmProvider): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  appendUnique(out, seen, provider.apiConfig?.defaultModel);
  for (const model of provider.apiConfig?.supportedModels || []) {
    appendUnique(out, seen, model);
  }
  return out;
}

function resolveSelectedProviderModels(
  config: PanelConfigNew,
  provider: PanelLlmProvider,
): string[] {
  const explicit = collectExplicitProviderModels(provider);
  if (explicit.length > 0) return explicit;
  return collectProviderAssignedModels(config, provider.id);
}

export function listCustomProviders(
  config: PanelConfigNew,
): CustomProviderSummary[] {
  return config.llmProviders
    .filter(
      (provider) =>
        !provider.builtin &&
        trim(provider.id) !== BUILTIN_CURSOR_HELP_PROFILE_ID &&
        provider.type === "model_llm",
    )
    .map((provider) => {
      const selectedModels = resolveSelectedProviderModels(config, provider);
      return {
        id: provider.id,
        name: trim(provider.name) || trim(provider.id),
        apiBase: trim(provider.apiConfig?.apiBase),
        selectedModels,
        selectedModelCount: selectedModels.length,
      };
    });
}

export function readCustomProviderDraft(
  config: PanelConfigNew,
  providerId: string,
): CustomProviderDraft | null {
  const provider = findProvider(config, providerId);
  if (!provider) return null;
  if (provider.builtin) return null;
  if (trim(provider.id) === BUILTIN_CURSOR_HELP_PROFILE_ID) return null;
  return {
    providerName: trim(provider.name) || trim(provider.id),
    apiBase: trim(provider.apiConfig?.apiBase),
    apiKey: String(provider.apiConfig?.apiKey || ""),
    supportedModels: resolveSelectedProviderModels(config, provider),
  };
}

export function createSceneModelValue(providerId: string, modelId: string): string {
  const normalizedProviderId = trim(providerId);
  const normalizedModelId = trim(modelId);
  return normalizedProviderId && normalizedModelId
    ? `${normalizedProviderId}::${normalizedModelId}`
    : "";
}

export function parseSceneModelValue(
  value: string,
): { providerId: string; modelId: string } | null {
  const normalized = trim(value);
  if (!normalized || normalized === ADD_CUSTOM_PROVIDER_OPTION_VALUE) return null;
  const separator = normalized.indexOf("::");
  if (separator <= 0 || separator >= normalized.length - 2) return null;
  return {
    providerId: normalized.slice(0, separator),
    modelId: normalized.slice(separator + 2),
  };
}

export function collectSceneModelOptions(
  config: PanelConfigNew,
  builtinFreeCatalog: BuiltinFreeModelCatalog,
): SceneModelOption[] {
  const out: SceneModelOption[] = [];
  const seen = new Set<string>();
  const builtinModels: string[] = [];
  const builtinSeen = new Set<string>();
  appendUnique(
    builtinModels,
    builtinSeen,
    resolveCursorHelpDisplayModel(builtinFreeCatalog.selectedModel),
  );
  for (const model of builtinFreeCatalog.availableModels) {
    appendUnique(
      builtinModels,
      builtinSeen,
      resolveCursorHelpDisplayModel(model),
    );
  }
  for (const modelId of builtinModels) {
    const value = createSceneModelValue(BUILTIN_CURSOR_HELP_PROFILE_ID, modelId);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      providerId: BUILTIN_CURSOR_HELP_PROFILE_ID,
      providerLabel: BUILTIN_FREE_PROVIDER_LABEL,
      modelId,
      label: `${BUILTIN_FREE_PROVIDER_LABEL} / ${modelId}`,
    });
  }

  for (const provider of config.llmProviders) {
    if (trim(provider.id) === BUILTIN_CURSOR_HELP_PROFILE_ID) continue;
    const models = collectCustomProviderModels(config, provider);
    if (models.length <= 0) continue;
    const providerLabel = trim(provider.name) || trim(provider.id);
    for (const modelId of models) {
      const value = createSceneModelValue(provider.id, modelId);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push({
        value,
        providerId: provider.id,
        providerLabel,
        modelId,
        label: `${providerLabel} / ${modelId}`,
      });
    }
  }

  return out;
}

function resolveBuiltinSceneModel(
  profile: PanelLlmProfileNew | null,
  builtinFreeCatalog: BuiltinFreeModelCatalog,
): string {
  const available = Array.isArray(builtinFreeCatalog.availableModels)
    ? builtinFreeCatalog.availableModels.map((item) =>
        resolveCursorHelpDisplayModel(item),
      )
    : [];
  if (available.length <= 0) return "";
  const requested = resolveCursorHelpDisplayModel(trim(profile?.modelId));
  if (requested && requested !== "auto") return requested;
  return (
    resolveCursorHelpDisplayModel(trim(builtinFreeCatalog.selectedModel)) ||
    available[0] ||
    ""
  );
}

function resolveSceneModelValue(
  config: PanelConfigNew,
  profileId: string,
  builtinFreeCatalog: BuiltinFreeModelCatalog,
): string {
  const profile = findProfile(config, profileId);
  if (!profile) return "";
  if (trim(profile.providerId) === BUILTIN_CURSOR_HELP_PROFILE_ID) {
    return createSceneModelValue(
      BUILTIN_CURSOR_HELP_PROFILE_ID,
      resolveBuiltinSceneModel(profile, builtinFreeCatalog),
    );
  }
  return createSceneModelValue(profile.providerId, profile.modelId);
}

export function deriveSceneModelDraft(
  config: PanelConfigNew,
  builtinFreeCatalog: BuiltinFreeModelCatalog,
): SceneModelDraft {
  return {
    primaryValue: resolveSceneModelValue(
      config,
      config.llmDefaultProfile,
      builtinFreeCatalog,
    ),
    auxValue: resolveSceneModelValue(
      config,
      config.llmAuxProfile,
      builtinFreeCatalog,
    ),
    fallbackValue: resolveSceneModelValue(
      config,
      config.llmFallbackProfile,
      builtinFreeCatalog,
    ),
  };
}

export function applySceneModelDraft(
  config: PanelConfigNew,
  draft: SceneModelDraft,
): void {
  const primary = parseSceneModelValue(draft.primaryValue);
  if (!primary) {
    resetToBuiltinCursor(config);
    return;
  }

  ensureProvider(config, primary.providerId);
  const primaryProfile = ensureSceneRoleProfile(
    config,
    "primary",
    config.llmDefaultProfile,
    primary.providerId,
    primary.modelId,
  );
  config.llmDefaultProfile = primaryProfile.id;

  const aux = parseSceneModelValue(draft.auxValue);
  if (!aux) {
    config.llmAuxProfile = "";
  } else {
    ensureProvider(config, aux.providerId);
    const auxProfile = ensureSceneRoleProfile(
      config,
      "aux",
      config.llmAuxProfile,
      aux.providerId,
      aux.modelId,
    );
    config.llmAuxProfile = auxProfile.id;
  }

  const fallback = parseSceneModelValue(draft.fallbackValue);
  if (!fallback) {
    config.llmFallbackProfile = "";
  } else {
    ensureProvider(config, fallback.providerId);
    const fallbackProfile = ensureSceneRoleProfile(
      config,
      "fallback",
      config.llmFallbackProfile,
      fallback.providerId,
      fallback.modelId,
    );
    config.llmFallbackProfile = fallbackProfile.id;
  }
}

export function upsertCustomProvider(
  config: PanelConfigNew,
  draft: CustomProviderDraft,
  existingProviderId?: string,
): PanelLlmProvider {
  const providerName = trim(draft.providerName);
  const apiBase = trim(draft.apiBase);
  const apiKey = trim(draft.apiKey);
  const supportedModels = Array.from(
    new Set(draft.supportedModels.map((item) => trim(item)).filter(Boolean)),
  );

  let provider =
    config.llmProviders.find(
      (item) => trim(item.id) === trim(existingProviderId),
    ) ||
    config.llmProviders.find(
      (item) =>
        trim(item.id) !== BUILTIN_CURSOR_HELP_PROFILE_ID &&
        trim(item.name) === providerName,
    ) || null;

  if (!provider) {
    provider = {
      id: createCustomProviderId(config, providerName),
      name: providerName,
      type: "model_llm",
      apiConfig: {
        apiBase,
        apiKey,
        defaultModel: supportedModels[0] || undefined,
        supportedModels,
        supportsModelDiscovery: supportedModels.length > 0,
      },
      options: {},
      builtin: false,
    };
    config.llmProviders.push(provider);
    return provider;
  }

  provider.name = providerName;
  provider.type = "model_llm";
  const previousDefaultModel = trim(provider.apiConfig?.defaultModel);
  const defaultModel =
    supportedModels.find((item) => item === previousDefaultModel) ||
    supportedModels[0] ||
    undefined;
  provider.apiConfig = {
    apiBase,
    apiKey,
    defaultModel,
    supportedModels,
    supportsModelDiscovery: supportedModels.length > 0,
  };
  provider.builtin = false;
  return provider;
}
