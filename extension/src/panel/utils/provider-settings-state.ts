import {
  BUILTIN_CURSOR_HELP_PROFILE_ID,
  DEFAULT_PANEL_LLM_PROVIDER,
  type PanelConfigNew,
  type PanelLlmProfileNew,
  type PanelLlmProvider,
} from "../stores/config-store";

export interface ProviderSettingsDraft {
  primaryModelId: string;
  auxModelId: string;
  fallbackModelId: string;
}

type ManagedRole = "primary" | "aux" | "fallback";

function trim(value: unknown): string {
  return String(value || "").trim();
}

function isBuiltinCursorProfile(profile: PanelLlmProfileNew | null | undefined): boolean {
  return trim(profile?.id) === BUILTIN_CURSOR_HELP_PROFILE_ID;
}

function isManagedProfile(profile: PanelLlmProfileNew | null | undefined): boolean {
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
