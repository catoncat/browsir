export const CURSOR_HELP_WEB_PROVIDER_ID = "cursor_help_web";
export const CURSOR_HELP_WEB_BASE_URL = "browser-brain-loop://cursor-help-web";
export const CURSOR_HELP_WEB_API_KEY = "cursor-help-web";

export function isCursorHelpWebProvider(provider: unknown): boolean {
  return String(provider || "").trim().toLowerCase() === CURSOR_HELP_WEB_PROVIDER_ID;
}

export function normalizeProviderConnectionConfig(input: {
  provider: unknown;
  llmApiBase: unknown;
  llmApiKey: unknown;
}): { llmApiBase: string; llmApiKey: string } {
  if (isCursorHelpWebProvider(input.provider)) {
    return {
      llmApiBase: CURSOR_HELP_WEB_BASE_URL,
      llmApiKey: CURSOR_HELP_WEB_API_KEY
    };
  }

  return {
    llmApiBase: String(input.llmApiBase || "").trim(),
    llmApiKey: String(input.llmApiKey || "")
  };
}
