export const CURSOR_HELP_WEB_PROVIDER_ID = "cursor_help_web";

export type ProviderRuntimeKind = "model_llm" | "hosted_chat";
export type ProviderToolSchemaDialect = "openai_compatible" | "hosted_chat";

export function isCursorHelpWebProvider(provider: unknown): boolean {
  return String(provider || "").trim().toLowerCase() === CURSOR_HELP_WEB_PROVIDER_ID;
}

export function getProviderRuntimeKind(provider: unknown): ProviderRuntimeKind {
  return isCursorHelpWebProvider(provider) ? "hosted_chat" : "model_llm";
}

// Current product constraint: every non-cursor provider uses the OpenAI-compatible tool schema path.
export function getProviderToolSchemaDialect(
  provider: unknown,
): ProviderToolSchemaDialect {
  return isCursorHelpWebProvider(provider)
    ? "hosted_chat"
    : "openai_compatible";
}

export function providerUsesOpenAiCompatibleToolSchema(
  provider: unknown,
): boolean {
  return getProviderToolSchemaDialect(provider) === "openai_compatible";
}

export function providerRequiresApiConnection(provider: unknown): boolean {
  return getProviderRuntimeKind(provider) === "model_llm";
}

export function normalizeProviderConnectionConfig(input: {
  provider: unknown;
  llmApiBase: unknown;
  llmApiKey: unknown;
}): { llmApiBase: string; llmApiKey: string } {
  if (!providerRequiresApiConnection(input.provider)) {
    return {
      llmApiBase: "",
      llmApiKey: "",
    };
  }

  return {
    llmApiBase: String(input.llmApiBase || "").trim(),
    llmApiKey: String(input.llmApiKey || ""),
  };
}
