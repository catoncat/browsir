import { DEFAULT_LLM_PROVIDER_ID } from "./llm-provider";
import { createOpenAiCompatibleLlmProvider } from "./llm-openai-compatible-provider";
import type { LlmProviderRegistry } from "./llm-provider-registry";
import { getProviderRuntimeKind } from "../../shared/llm-provider-config";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function syncCatalogModelLlmProviders(
  providerRegistry: LlmProviderRegistry,
  config: { llmProviderCatalog?: unknown },
): string[] {
  const rawCatalog = Array.isArray(config.llmProviderCatalog)
    ? config.llmProviderCatalog
    : [];
  const synced: string[] = [];

  for (const item of rawCatalog) {
    const row = asRecord(item);
    const id = String(row.id || "").trim();
    if (!id || id === DEFAULT_LLM_PROVIDER_ID) continue;

    const runtimeKind =
      row.type === "model_llm" || row.type === "hosted_chat"
        ? row.type
        : getProviderRuntimeKind(id);
    if (runtimeKind !== "model_llm") continue;
    if (providerRegistry.has(id)) continue;

    providerRegistry.register(createOpenAiCompatibleLlmProvider(id));
    synced.push(id);
  }

  return synced;
}
