import { type LlmProviderAdapter, type LlmProviderSendInput } from "./llm-provider";

export function createOpenAiCompatibleLlmProvider(providerId = "openai_compatible"): LlmProviderAdapter {
  const id = String(providerId || "").trim() || "openai_compatible";
  return {
    id,
    resolveRequestUrl(route) {
      const base = String(route.llmBase || "").trim().replace(/\/+$/, "");
      return `${base}/chat/completions`;
    },
    async send(input: LlmProviderSendInput): Promise<Response> {
      const requestUrl = String(input.requestUrl || "").trim() || this.resolveRequestUrl(input.route);
      return await fetch(requestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${String(input.route.llmKey || "")}`
        },
        body: JSON.stringify(input.payload),
        signal: input.signal
      });
    }
  };
}
