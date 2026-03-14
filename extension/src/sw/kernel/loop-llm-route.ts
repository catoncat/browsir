/**
 * loop-llm-route.ts — LLM 路由与重试策略相关工具
 */
import type { BridgeConfig } from "./infra-bridge-client";
import { DEFAULT_LLM_ROLE, type LlmResolvedRoute } from "./llm-provider";
import { resolveLlmRoute } from "./llm-profile-resolver";
import { normalizeErrorCode, toRecord } from "./loop-shared-utils";
import { nowIso } from "./types";
import { getProviderRuntimeKind } from "../../shared/llm-provider-config";

type JsonRecord = Record<string, unknown>;

export interface SessionLlmRoutePrefs {
  profile?: string;
  role?: string;
}

export function readSessionLlmRoutePrefs(
  meta: { header?: { metadata?: unknown } } | null | undefined,
): SessionLlmRoutePrefs {
  const metadata = toRecord(meta?.header?.metadata);
  const profile = String(metadata.llmProfile || "").trim();
  const role = String(metadata.llmRole || "").trim();
  return {
    profile: profile || undefined,
    role: role || undefined,
  };
}

export function withSessionLlmRouteMeta<T extends { header: { metadata?: unknown } }>(
  meta: T,
  route: LlmResolvedRoute,
): T & { updatedAt: string } {
  const metadata = {
    ...toRecord(meta.header.metadata),
    llmResolvedProfile: route.profile,
    llmResolvedProvider: route.provider,
    llmResolvedModel: route.llmModel,
    llmResolvedRole: route.role,
    llmResolvedEscalationPolicy: route.escalationPolicy,
  };
  return {
    ...meta,
    header: {
      ...meta.header,
      metadata,
    },
    updatedAt: nowIso(),
  };
}

export function buildLlmRoutePayload(
  route: LlmResolvedRoute,
  extra: JsonRecord = {},
): JsonRecord {
  return {
    profile: route.profile,
    provider: route.provider,
    runtimeKind: route.runtimeKind,
    model: route.llmModel,
    role: route.role,
    fromLegacy: route.fromLegacy,
    ...extra,
  };
}

export function buildLlmFailureSignature(error: unknown): string {
  const err = error as { code?: string; status?: unknown; message?: unknown };
  const code = normalizeErrorCode(err.code) || "E_UNKNOWN";
  const status = Number(err.status || 0);
  const msg = String(err.message || "")
    .trim()
    .toLowerCase()
    .slice(0, 180);
  return `${code}|${status || 0}|${msg}`;
}

export function resolveAuxiliaryLlmRoute(config: BridgeConfig) {
  const auxProfile = String(config.llmAuxProfile || "").trim();
  const profile =
    auxProfile ||
    String(config.llmDefaultProfile || "default").trim() ||
    "default";
  return resolveLlmRoute({
    config,
    profile,
    role: DEFAULT_LLM_ROLE,
    escalationPolicy: "disabled",
  });
}

function collectConfiguredProfileIds(config: BridgeConfig): string[] {
  const rawProfiles = Array.isArray(config.llmProfiles) ? config.llmProfiles : [];
  const out: string[] = [];
  for (const item of rawProfiles) {
    const row = toRecord(item);
    const id = String(row.id || "").trim();
    if (!id) continue;
    out.push(id);
  }
  return out;
}

export function resolveAuxiliaryNonHostedLlmRoute(config: BridgeConfig) {
  const resolved = resolveAuxiliaryLlmRoute(config);
  if (!resolved.ok) return resolved;
  if (resolved.route.runtimeKind !== "hosted_chat") {
    return resolved;
  }

  const preferredProfile = String(resolved.route.profile || "").trim();
  const candidateProfiles = new Set<string>([
    ...resolved.route.orderedProfiles,
    ...collectConfiguredProfileIds(config),
  ]);

  for (const profile of candidateProfiles) {
    const normalized = String(profile || "").trim();
    if (!normalized || normalized === preferredProfile) continue;
    const candidate = resolveLlmRoute({
      config,
      profile: normalized,
      role: DEFAULT_LLM_ROLE,
      escalationPolicy: "disabled",
    });
    if (!candidate.ok) continue;
    const runtimeKind =
      candidate.route.runtimeKind ||
      getProviderRuntimeKind(candidate.route.provider);
    if (runtimeKind === "hosted_chat") continue;
    return candidate;
  }

  return resolved;
}

export function resolvePrimaryLlmRoute(
  config: BridgeConfig,
  routePrefs: SessionLlmRoutePrefs,
) {
  const hasExplicitProfile = Boolean(String(routePrefs.profile || "").trim());
  return resolveLlmRoute({
    config,
    profile: routePrefs.profile,
    role: routePrefs.role,
    escalationPolicy: hasExplicitProfile ? "disabled" : undefined,
  });
}

export function isRetryableLlmStatus(status: number): boolean {
  return [408, 409, 429, 500, 502, 503, 504].includes(Number(status || 0));
}

export function computeRetryDelayMs(attempt: number): number {
  const base = 500;
  const cap = 4000;
  const next = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(cap, next);
}

export function parseRetryAfterHeaderValue(raw: string): number | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return null;
  const delta = ts - Date.now();
  if (delta <= 0) return null;
  return Math.ceil(delta);
}

export function extractRetryDelayHintMs(
  rawBody: string,
  resp: Response,
): number | null {
  const retryAfter = parseRetryAfterHeaderValue(
    String(resp.headers.get("retry-after") || ""),
  );
  if (retryAfter !== null) return retryAfter;

  const xRateLimitReset = String(
    resp.headers.get("x-ratelimit-reset") || "",
  ).trim();
  if (xRateLimitReset) {
    const sec = Number.parseInt(xRateLimitReset, 10);
    if (Number.isFinite(sec)) {
      const delta = sec * 1000 - Date.now();
      if (delta > 0) return Math.ceil(delta);
    }
  }

  const xRateLimitResetAfter = String(
    resp.headers.get("x-ratelimit-reset-after") || "",
  ).trim();
  if (xRateLimitResetAfter) {
    const sec = Number(xRateLimitResetAfter);
    if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
  }

  const text = String(rawBody || "");
  const retryDelayField = /"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(text);
  if (retryDelayField) {
    const sec = Number(retryDelayField[1]);
    if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
  }

  const resetAfter = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i.exec(
    text,
  );
  if (resetAfter) {
    const hours = resetAfter[1] ? Number.parseInt(resetAfter[1], 10) : 0;
    const minutes = resetAfter[2] ? Number.parseInt(resetAfter[2], 10) : 0;
    const seconds = Number(resetAfter[3]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(((hours * 60 + minutes) * 60 + seconds) * 1000);
    }
  }

  const retryIn = /retry in (\d+(?:\.\d+)?)\s*(ms|s)/i.exec(text);
  if (retryIn) {
    const amount = Number(retryIn[1]);
    if (Number.isFinite(amount) && amount > 0) {
      return Math.ceil(
        retryIn[2].toLowerCase() === "ms" ? amount : amount * 1000,
      );
    }
  }

  return null;
}
