import type { BridgeConfig } from "./runtime-infra.browser";
import {
  DEFAULT_LLM_PROFILE_ID,
  DEFAULT_LLM_PROVIDER_ID,
  DEFAULT_LLM_ROLE,
  type LlmResolvedRoute
} from "./llm-provider";
import type { LlmProfileEscalationPolicy } from "./llm-profile-policy";

type JsonRecord = Record<string, unknown>;

interface LlmProfileDef {
  id: string;
  provider: string;
  llmBase: string;
  llmKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
  role: string;
}

export interface ResolveLlmRouteInput {
  config: BridgeConfig;
  profile?: string;
  role?: string;
  escalationPolicy?: LlmProfileEscalationPolicy;
}

export type ResolveLlmRouteResult =
  | {
      ok: true;
      route: LlmResolvedRoute;
    }
  | {
      ok: false;
      reason: "profile_not_found" | "missing_llm_config";
      message: string;
      profile: string;
      role: string;
    };

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizePolicy(raw: unknown): LlmProfileEscalationPolicy {
  return String(raw || "").trim().toLowerCase() === "disabled" ? "disabled" : "upgrade_only";
}

function normalizeRole(raw: unknown): string {
  const role = String(raw || "").trim();
  return role || DEFAULT_LLM_ROLE;
}

function normalizeProfileId(raw: unknown): string {
  const id = String(raw || "").trim();
  return id || DEFAULT_LLM_PROFILE_ID;
}

function toIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function normalizeProfileDef(raw: JsonRecord, fallbackId: string, fallbackConfig: BridgeConfig): LlmProfileDef | null {
  const id = normalizeProfileId(raw.id || fallbackId);
  const provider = String(raw.provider || DEFAULT_LLM_PROVIDER_ID).trim() || DEFAULT_LLM_PROVIDER_ID;
  const llmBase = String(raw.llmApiBase || "").trim();
  const llmKey = String(raw.llmApiKey || "").trim();
  const llmModel = String(raw.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex";
  const role = normalizeRole(raw.role);
  const llmTimeoutMs = toIntInRange(raw.llmTimeoutMs, fallbackConfig.llmTimeoutMs, 1_000, 300_000);
  const llmRetryMaxAttempts = toIntInRange(raw.llmRetryMaxAttempts, fallbackConfig.llmRetryMaxAttempts, 0, 6);
  const llmMaxRetryDelayMs = toIntInRange(raw.llmMaxRetryDelayMs, fallbackConfig.llmMaxRetryDelayMs, 0, 300_000);
  if (!id) return null;
  return {
    id,
    provider,
    llmBase,
    llmKey,
    llmModel,
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
    role
  };
}

function collectProfiles(config: BridgeConfig): Map<string, LlmProfileDef> {
  const map = new Map<string, LlmProfileDef>();

  const rawProfiles = (config as BridgeConfig & { llmProfiles?: unknown }).llmProfiles;
  if (!Array.isArray(rawProfiles)) return map;

  for (const item of rawProfiles) {
    const row = asRecord(item);
    const fallbackId = normalizeProfileId(row.id);
    const normalized = normalizeProfileDef(row, fallbackId, config);
    if (!normalized) continue;
    map.set(normalized.id, normalized);
  }

  return map;
}

function resolveOrderedProfiles(
  config: BridgeConfig,
  role: string,
  selectedProfile: string,
  profiles: Map<string, LlmProfileDef>
): string[] {
  const chains = asRecord((config as BridgeConfig & { llmProfileChains?: unknown }).llmProfileChains);
  const roleChainRaw = chains[role];
  const chain = Array.isArray(roleChainRaw)
    ? roleChainRaw
        .map((item) => String(item || "").trim())
        .filter((id) => id && profiles.has(id))
    : [];

  if (chain.length > 0) {
    if (!chain.includes(selectedProfile)) return [selectedProfile, ...chain];
    return chain;
  }

  const sameRole = Array.from(profiles.values())
    .filter((item) => item.role === role)
    .map((item) => item.id);
  if (sameRole.length > 0) {
    if (!sameRole.includes(selectedProfile)) return [selectedProfile, ...sameRole];
    return sameRole;
  }

  return [selectedProfile];
}

export function resolveLlmRoute(input: ResolveLlmRouteInput): ResolveLlmRouteResult {
  const { config } = input;
  const profiles = collectProfiles(config);

  const profile =
    normalizeProfileId(
      input.profile || (config as BridgeConfig & { llmDefaultProfile?: unknown }).llmDefaultProfile || DEFAULT_LLM_PROFILE_ID
    ) || DEFAULT_LLM_PROFILE_ID;
  const preferredRoleRaw = String(input.role || "").trim();
  const escalationPolicy = normalizePolicy(input.escalationPolicy || (config as BridgeConfig & { llmEscalationPolicy?: unknown }).llmEscalationPolicy);

  const selected =
    profiles.get(profile) ||
    (profile !== DEFAULT_LLM_PROFILE_ID ? profiles.get(DEFAULT_LLM_PROFILE_ID) : undefined) ||
    Array.from(profiles.values())[0];
  if (!selected) {
    return {
      ok: false,
      reason: "profile_not_found",
      message: `未找到可用 llm profile: ${profile}`,
      profile,
      role: normalizeRole(preferredRoleRaw)
    };
  }
  const role = normalizeRole(preferredRoleRaw || selected.role);

  if (!String(selected.llmBase || "").trim() || !String(selected.llmKey || "").trim()) {
    return {
      ok: false,
      reason: "missing_llm_config",
      message: "执行失败：当前未配置可用 LLM（llmApiBase/llmApiKey）。",
      profile: selected.id,
      role
    };
  }

  return {
    ok: true,
    route: {
      profile: selected.id,
      provider: selected.provider || DEFAULT_LLM_PROVIDER_ID,
      llmBase: selected.llmBase,
      llmKey: selected.llmKey,
      llmModel: selected.llmModel,
      llmTimeoutMs: selected.llmTimeoutMs,
      llmRetryMaxAttempts: selected.llmRetryMaxAttempts,
      llmMaxRetryDelayMs: selected.llmMaxRetryDelayMs,
      role,
      escalationPolicy,
      orderedProfiles: resolveOrderedProfiles(config, role, selected.id, profiles),
      fromLegacy: false
    }
  };
}
