import type { BrainOrchestrator } from "./orchestrator.browser";
import { SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.browser";
import type { LlmProviderRegistry } from "./llm-provider-registry";
import type { RuntimeInfraHandler } from "./runtime-infra.browser";
import {
  computeRetryDelayMs,
  extractRetryDelayHintMs,
  isRetryableLlmStatus,
  resolveAuxiliaryLlmRoute,
} from "./loop-llm-route";
import {
  parseLlmMessageFromBody,
  readHostedChatTurnFromTransportStream,
  resolveRouteRuntimeKind,
} from "./loop-llm-stream";
import { parseLlmContent } from "./loop-session-title";
import {
  DEFAULT_LLM_MAX_RETRY_DELAY_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  MAX_LLM_MAX_RETRY_DELAY_MS,
  MAX_LLM_TIMEOUT_MS,
  MAX_LLM_RETRIES,
  MIN_LLM_MAX_RETRY_DELAY_MS,
  MIN_LLM_TIMEOUT_MS,
  type RuntimeErrorWithMeta,
} from "./loop-shared-types";
import {
  asRuntimeErrorWithMeta,
  callInfra,
  delay,
  extractLlmConfig,
  isPlainJsonRecord,
  normalizeIntInRange,
  toRecord,
} from "./loop-shared-utils";
import type { JsonRecord } from "./types";

interface BuildLlmRawTracePayloadInput {
  step: number;
  attempt: number;
  status: number;
  ok: boolean;
  body: string;
  retryDelayHintMs?: number | null;
  source?: string;
  contentType?: string;
}

interface RequestCompactionSummaryFromLlmInput {
  orchestrator: BrainOrchestrator;
  infra: RuntimeInfraHandler;
  providerRegistry: LlmProviderRegistry;
  sessionId: string;
  mode: "history" | "turn_prefix";
  promptText: string;
  maxTokens: number;
  summarizeLlmRequestPayload: (payload: JsonRecord) => JsonRecord;
  buildLlmRawTracePayload: (
    input: BuildLlmRawTracePayloadInput,
  ) => JsonRecord;
}

function createNonRetryableRuntimeError(
  code: string,
  message: string,
  details?: unknown,
): RuntimeErrorWithMeta {
  const err = new Error(message) as RuntimeErrorWithMeta;
  err.code = code;
  err.retryable = false;
  if (details !== undefined) {
    err.details = details;
  }
  return err;
}

export async function requestCompactionSummaryFromLlm(
  input: RequestCompactionSummaryFromLlmInput,
): Promise<string> {
  const cfgRaw = await callInfra(input.infra, { type: "config.get" });
  const config = extractLlmConfig(cfgRaw);
  const resolvedRoute = resolveAuxiliaryLlmRoute(config);
  if (!resolvedRoute.ok) {
    throw new Error(resolvedRoute.message);
  }
  const route = resolvedRoute.route;
  const provider = input.providerRegistry.get(
    String(route.provider || "").trim(),
  );
  if (!provider) {
    throw new Error(`未找到 LLM provider: ${route.provider}`);
  }

  const llmModel =
    String(route.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex";
  const llmTimeoutMs = normalizeIntInRange(
    route.llmTimeoutMs,
    DEFAULT_LLM_TIMEOUT_MS,
    MIN_LLM_TIMEOUT_MS,
    MAX_LLM_TIMEOUT_MS,
  );
  const llmRetryMaxAttempts = normalizeIntInRange(
    route.llmRetryMaxAttempts,
    MAX_LLM_RETRIES,
    0,
    6,
  );
  const llmMaxRetryDelayMs = normalizeIntInRange(
    route.llmMaxRetryDelayMs,
    DEFAULT_LLM_MAX_RETRY_DELAY_MS,
    MIN_LLM_MAX_RETRY_DELAY_MS,
    MAX_LLM_MAX_RETRY_DELAY_MS,
  );
  const baseUrl = provider.resolveRequestUrl(route);
  const basePayload: JsonRecord = {
    model: llmModel,
    messages: [
      { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: "user", content: String(input.promptText || "") },
    ],
    max_tokens: normalizeIntInRange(input.maxTokens, 2048, 128, 32768),
    temperature: 0.2,
    stream: false,
  };
  const totalAttempts = Math.max(1, llmRetryMaxAttempts + 1);

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const beforeRequest = await input.orchestrator.runHook(
        "llm.before_request",
        {
          request: {
            sessionId: input.sessionId,
            step: 0,
            attempt,
            mode: input.mode,
            source: "compaction",
            url: baseUrl,
            payload: basePayload,
          },
        },
      );
      if (beforeRequest.blocked) {
        throw createNonRetryableRuntimeError(
          "E_LLM_HOOK_BLOCKED",
          `llm.before_request blocked: ${beforeRequest.reason || "blocked"}`,
        );
      }
      const patchedRequest = toRecord(beforeRequest.value.request);
      const requestUrlRaw = patchedRequest.url;
      if (requestUrlRaw !== undefined && typeof requestUrlRaw !== "string") {
        throw createNonRetryableRuntimeError(
          "E_LLM_HOOK_INVALID_PATCH",
          "llm.before_request patch request.url must be a string",
        );
      }
      const requestPayloadRaw = patchedRequest.payload;
      if (
        requestPayloadRaw !== undefined &&
        !isPlainJsonRecord(requestPayloadRaw)
      ) {
        throw createNonRetryableRuntimeError(
          "E_LLM_HOOK_INVALID_PATCH",
          "llm.before_request patch request.payload must be an object",
        );
      }
      const requestUrl = String(requestUrlRaw || baseUrl).trim() || baseUrl;
      const requestPayload: JsonRecord = {
        ...basePayload,
        ...(requestPayloadRaw || {}),
      };
      if (!Array.isArray(requestPayload.messages)) {
        requestPayload.messages = basePayload.messages;
      }
      if (!String(requestPayload.model || "").trim()) {
        requestPayload.model = llmModel;
      }
      if (typeof requestPayload.stream !== "boolean") {
        requestPayload.stream = false;
      }

      input.orchestrator.events.emit("llm.request", input.sessionId, {
        step: 0,
        attempt,
        mode: "compaction",
        summaryMode: input.mode,
        source: "compaction",
        url: requestUrl,
        model: llmModel,
        profile: route.profile,
        provider: route.provider,
        ...input.summarizeLlmRequestPayload(requestPayload),
      });

      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort("compaction-summary-timeout"),
        llmTimeoutMs,
      );
      let response: Response;
      try {
        response = await provider.send({
          sessionId: input.sessionId,
          step: 0,
          lane: "compaction",
          route,
          requestUrl,
          signal: ctrl.signal,
          payload: requestPayload,
        });
      } finally {
        clearTimeout(timer);
      }

      const status = response.status;
      const ok = response.ok;
      const contentType = String(response.headers.get("content-type") || "");
      const isHostedChat =
        resolveRouteRuntimeKind(route) === "hosted_chat";

      let rawBody: string;
      let hostedMessage: JsonRecord | null = null;

      if (ok && isHostedChat && response.body) {
        const hosted =
          await readHostedChatTurnFromTransportStream(response.body);
        rawBody = hosted.rawBody;
        hostedMessage = { content: hosted.result.assistantText };
      } else {
        rawBody = await response.text();
      }

      const retryDelayHintMs = ok
        ? null
        : extractRetryDelayHintMs(rawBody, response);
      input.orchestrator.events.emit(
        "llm.response.raw",
        input.sessionId,
        input.buildLlmRawTracePayload({
          step: 0,
          attempt,
          status,
          ok,
          retryDelayHintMs,
          body: rawBody,
          source: "compaction",
          contentType,
        }),
      );

      if (!ok) {
        if (attempt < totalAttempts && isRetryableLlmStatus(status)) {
          const delayMs = Math.max(
            0,
            Math.min(
              llmMaxRetryDelayMs > 0
                ? llmMaxRetryDelayMs
                : Number.MAX_SAFE_INTEGER,
              retryDelayHintMs ?? computeRetryDelayMs(attempt),
            ),
          );
          if (delayMs > 0) {
            await delay(delayMs);
          }
          continue;
        }
        const err = new Error(
          `Compaction summary HTTP ${status}`,
        ) as RuntimeErrorWithMeta;
        err.status = status;
        throw err;
      }

      const message =
        hostedMessage ?? parseLlmMessageFromBody(rawBody, contentType);
      const afterResponse = await input.orchestrator.runHook(
        "llm.after_response",
        {
          request: {
            sessionId: input.sessionId,
            step: 0,
            attempt,
            mode: input.mode,
            source: "compaction",
            url: requestUrl,
            payload: requestPayload,
            status,
            ok,
          },
          response: message,
        },
      );
      if (afterResponse.blocked) {
        throw createNonRetryableRuntimeError(
          "E_LLM_HOOK_BLOCKED",
          `llm.after_response blocked: ${afterResponse.reason || "blocked"}`,
        );
      }
      if (!isPlainJsonRecord(afterResponse.value.response)) {
        throw createNonRetryableRuntimeError(
          "E_LLM_HOOK_INVALID_PATCH",
          "llm.after_response patch response must be an object",
        );
      }
      const summary = parseLlmContent(afterResponse.value.response).trim();
      if (!summary) {
        throw new Error("Compaction summary 为空");
      }
      return summary;
    } catch (error) {
      if (attempt >= totalAttempts) {
        throw error;
      }
      const err = asRuntimeErrorWithMeta(error);
      const reason = String(err.message || "");
      if (
        reason.includes("llm.before_request blocked") ||
        reason.includes("llm.after_response blocked")
      ) {
        throw error;
      }
      if (reason.includes("Compaction summary 为空")) {
        throw error;
      }
      const status = Number(err.status || 0);
      const retryableStatus =
        typeof err.retryable === "boolean"
          ? err.retryable
          : Number.isInteger(status) && status > 0
            ? isRetryableLlmStatus(status)
            : true;
      if (!retryableStatus) {
        throw error;
      }
      const fallbackDelayMs = Math.max(
        0,
        Math.min(llmMaxRetryDelayMs, computeRetryDelayMs(attempt)),
      );
      if (fallbackDelayMs > 0) {
        await delay(fallbackDelayMs);
      }
    }
  }

  throw new Error("compaction summary 请求失败");
}
