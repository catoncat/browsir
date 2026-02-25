import type { LlmProfileEscalationPolicy } from "./llm-profile-policy";

type JsonRecord = Record<string, unknown>;

export const DEFAULT_LLM_PROVIDER_ID = "openai_compatible";
export const DEFAULT_LLM_PROFILE_ID = "default";
export const DEFAULT_LLM_ROLE = "worker";

export interface LlmResolvedRoute {
  profile: string;
  provider: string;
  llmBase: string;
  llmKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
  role: string;
  escalationPolicy: LlmProfileEscalationPolicy;
  orderedProfiles: string[];
  fromLegacy: boolean;
}

export interface LlmProviderSendInput {
  route: LlmResolvedRoute;
  payload: JsonRecord;
  signal: AbortSignal;
  requestUrl?: string;
}

export interface LlmProviderAdapter {
  id: string;
  resolveRequestUrl(route: LlmResolvedRoute): string;
  send(input: LlmProviderSendInput): Promise<Response>;
}
