import type { BrainOrchestrator, ToolDefinition } from "./orchestrator.browser";
import { transformMessagesForLlm } from "./llm-message-model.browser";
import {
  computeRetryDelayMs,
  extractRetryDelayHintMs,
  isRetryableLlmStatus,
} from "./loop-llm-route";
import {
  buildHostedChatEventPayload,
  parseLlmMessageFromBody,
  readHostedChatTurnFromTransportStream,
  readLlmMessageFromSseStream,
  resolveRouteRuntimeKind,
} from "./loop-llm-stream";
import { parseLlmContent } from "./loop-session-title";
import {
  DEFAULT_LLM_MAX_RETRY_DELAY_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  type LlmRequestInput,
  MAX_LLM_MAX_RETRY_DELAY_MS,
  MAX_LLM_RETRIES,
  MAX_LLM_TIMEOUT_MS,
  MIN_LLM_MAX_RETRY_DELAY_MS,
  MIN_LLM_TIMEOUT_MS,
  type RuntimeErrorWithMeta,
} from "./loop-shared-types";
import {
  asRuntimeErrorWithMeta,
  delay,
  isPlainJsonRecord,
  normalizeIntInRange,
  normalizeToolCalls,
  sanitizeLlmToolDefinitionForProvider,
  toRecord,
} from "./loop-shared-utils";
import type { JsonRecord } from "./types";
import type { HostedChatTurnResult } from "../../shared/cursor-help-web-shared";

// ── Types ───────────────────────────────────────────────────────────

export interface BuildLlmRawTracePayloadInput {
  step: number;
  attempt: number;
  status: number;
  ok: boolean;
  body: string;
  retryDelayHintMs?: number | null;
  source?: string;
  contentType?: string;
}

export interface LlmRequestWithRetryInput extends LlmRequestInput {
  orchestrator: BrainOrchestrator;
  listToolDefinitions: (scope: "all" | "browser_only") => ToolDefinition[];
  summarizeLlmRequestPayload: (payload: JsonRecord) => JsonRecord;
  buildLlmRawTracePayload: (input: BuildLlmRawTracePayloadInput) => JsonRecord;
}

// ── Internal helpers ────────────────────────────────────────────────

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

// ── Main export ─────────────────────────────────────────────────────

export async function requestLlmWithRetry(
  input: LlmRequestWithRetryInput,
): Promise<JsonRecord> {
  const {
    orchestrator,
    sessionId,
    route,
    providerRegistry,
    step,
    messages,
    listToolDefinitions,
    summarizeLlmRequestPayload,
    buildLlmRawTracePayload,
  } = input;
  const toolChoice = input.toolChoice === "required" ? "required" : "auto";
  const toolScope =
    input.toolScope === "browser_only" ? "browser_only" : "all";
  const llmModel =
    String(route.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex";
  const llmTimeoutMs = normalizeIntInRange(
    route.llmTimeoutMs,
    DEFAULT_LLM_TIMEOUT_MS,
    MIN_LLM_TIMEOUT_MS,
    MAX_LLM_TIMEOUT_MS,
  );
  const llmMaxRetryDelayMs = normalizeIntInRange(
    route.llmMaxRetryDelayMs,
    DEFAULT_LLM_MAX_RETRY_DELAY_MS,
    MIN_LLM_MAX_RETRY_DELAY_MS,
    MAX_LLM_MAX_RETRY_DELAY_MS,
  );
  const provider = providerRegistry.get(String(route.provider || "").trim());
  if (!provider) {
    throw createNonRetryableRuntimeError(
      "E_LLM_PROVIDER_NOT_FOUND",
      `未找到 LLM provider: ${route.provider}`,
      {
        provider: route.provider,
        profile: route.profile,
      },
    );
  }
  const isHostedChatRoute = resolveRouteRuntimeKind(route) === "hosted_chat";
  let lastError: unknown = null;
  const configuredMaxAttempts = Number(
    orchestrator.getRunState(sessionId).retry.maxAttempts ?? MAX_LLM_RETRIES,
  );
  const maxAttempts = Number.isFinite(configuredMaxAttempts)
    ? Math.max(0, configuredMaxAttempts)
    : MAX_LLM_RETRIES;
  const totalAttempts = maxAttempts + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("llm-timeout"), llmTimeoutMs);
    let status = 0;
    let ok = false;
    let rawBody = "";
    let contentType = "";
    try {
      const llmToolDefs = listToolDefinitions(toolScope).map((definition) =>
        sanitizeLlmToolDefinitionForProvider(definition, route.provider),
      );
      const basePayload: JsonRecord = {
        model: llmModel,
        messages,
        tools: llmToolDefs,
        tool_choice: toolChoice,
        temperature: 0.2,
        stream: true,
      };
      const baseUrl = provider.resolveRequestUrl(route);
      const beforeRequest = await orchestrator.runHook("llm.before_request", {
        request: {
          sessionId,
          step,
          attempt,
          profile: route.profile,
          provider: route.provider,
          url: baseUrl,
          payload: basePayload,
        },
      });
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
      if (!Array.isArray(requestPayload.messages))
        requestPayload.messages = messages;
      if (!Array.isArray(requestPayload.tools))
        requestPayload.tools = llmToolDefs;
      if (!String(requestPayload.model || "").trim())
        requestPayload.model = llmModel;
      if (!requestPayload.tool_choice) requestPayload.tool_choice = toolChoice;
      if (
        typeof requestPayload.temperature !== "number" ||
        !Number.isFinite(requestPayload.temperature)
      ) {
        requestPayload.temperature = 0.2;
      }
      if (typeof requestPayload.stream !== "boolean")
        requestPayload.stream = true;
      requestPayload.messages = transformMessagesForLlm(
        Array.isArray(requestPayload.messages) ? requestPayload.messages : [],
      );

      orchestrator.events.emit("llm.request", sessionId, {
        step,
        url: requestUrl,
        model: String(requestPayload.model || llmModel),
        profile: route.profile,
        provider: route.provider,
        source: isHostedChatRoute ? "hosted_chat_transport" : "llm_provider",
        ...summarizeLlmRequestPayload(requestPayload),
      });

      const resp = await provider.send({
        sessionId,
        step,
        lane: "primary",
        route,
        requestUrl,
        payload: requestPayload,
        signal: ctrl.signal,
      });
      status = resp.status;
      ok = resp.ok;
      contentType = String(resp.headers.get("content-type") || "");

      if (!ok) {
        rawBody = await resp.text();
        const retryDelayHintMs = extractRetryDelayHintMs(rawBody, resp);
        orchestrator.events.emit(
          "llm.response.raw",
          sessionId,
          buildLlmRawTracePayload({
            step,
            attempt,
            status,
            ok,
            retryDelayHintMs,
            body: rawBody,
            source: isHostedChatRoute
              ? "hosted_chat_transport"
              : "llm_provider",
            contentType,
          }),
        );
        if (
          retryDelayHintMs != null &&
          llmMaxRetryDelayMs > 0 &&
          retryDelayHintMs > llmMaxRetryDelayMs
        ) {
          const exceeded = new Error(
            `LLM retry delay ${Math.ceil(retryDelayHintMs / 1000)}s exceeds cap ${Math.ceil(llmMaxRetryDelayMs / 1000)}s`,
          ) as RuntimeErrorWithMeta;
          exceeded.code = "E_LLM_RETRY_DELAY_EXCEEDED";
          exceeded.status = status;
          exceeded.details = {
            retryDelayHintMs,
            llmMaxRetryDelayMs,
          };
          exceeded.retryable = false;
          throw exceeded;
        }
        const err = new Error(`LLM HTTP ${status}`) as Error & {
          status?: number;
        };
        err.status = status;
        throw err;
      }

      let message: JsonRecord;
      let hostedTurnResult: HostedChatTurnResult | null = null;
      const lowerType = contentType.toLowerCase();
      if (isHostedChatRoute && resp.body) {
        const hosted = await readHostedChatTurnFromTransportStream(
          resp.body,
          (event) => {
            orchestrator.events.emit(
              event.type,
              sessionId,
              buildHostedChatEventPayload(step, attempt, event),
            );
          },
        );
        rawBody = hosted.rawBody;
        hostedTurnResult = hosted.result;
        message = {
          content: hosted.result.assistantText,
          tool_calls: hosted.result.toolCalls,
          hosted_chat_meta: hosted.result.meta,
          finish_reason: hosted.result.finishReason,
        };
      } else if (resp.body && lowerType.includes("text/event-stream")) {
        orchestrator.events.emit("llm.stream.start", sessionId, {
          step,
          attempt,
        });
        const streamed = await readLlmMessageFromSseStream(
          resp.body,
          (chunk) => {
            if (!chunk) return;
            orchestrator.events.emit("llm.stream.delta", sessionId, {
              step,
              attempt,
              text: chunk,
            });
          },
        );
        rawBody = streamed.rawBody;
        message = streamed.message;
        orchestrator.events.emit("llm.stream.end", sessionId, {
          step,
          attempt,
          packetCount: streamed.packetCount,
          contentLength: parseLlmContent(message).length,
          toolCalls: normalizeToolCalls(message.tool_calls).length,
        });
      } else {
        rawBody = await resp.text();
        message = parseLlmMessageFromBody(rawBody, contentType);
      }

      orchestrator.events.emit(
        "llm.response.raw",
        sessionId,
        buildLlmRawTracePayload({
          step,
          attempt,
          status,
          ok,
          body: rawBody,
          source: isHostedChatRoute ? "hosted_chat_transport" : "llm_provider",
          contentType,
        }),
      );
      const afterResponse = await orchestrator.runHook("llm.after_response", {
        request: {
          sessionId,
          step,
          attempt,
          profile: route.profile,
          provider: route.provider,
          url: requestUrl,
          payload: requestPayload,
          status,
          ok,
        },
        response: message,
      });
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
      message = afterResponse.value.response;
      if (isHostedChatRoute && hostedTurnResult) {
        hostedTurnResult = {
          assistantText: parseLlmContent(message),
          toolCalls: normalizeToolCalls(message.tool_calls),
          finishReason:
            String(message.finish_reason || "") === "tool_calls"
              ? "tool_calls"
              : hostedTurnResult.finishReason,
          meta: toRecord(message.hosted_chat_meta),
        };
      }

      const state = orchestrator.getRunState(sessionId);
      if (state.retry.active) {
        orchestrator.resetRetryState(sessionId);
        orchestrator.events.emit("auto_retry_end", sessionId, {
          success: true,
          attempt: attempt - 1,
          maxAttempts: state.retry.maxAttempts,
        });
      }

      return message;
    } catch (error) {
      const err = asRuntimeErrorWithMeta(error);
      lastError = err;
      const errText = error instanceof Error ? error.message : String(error);
      const statusCode = Number(err?.status || status || 0);
      const signalReason = String(ctrl.signal.reason || "");
      const retryable =
        typeof err.retryable === "boolean"
          ? err.retryable
          : isRetryableLlmStatus(statusCode) ||
            /timeout|network|temporar|unavailable|rate limit/i.test(
              `${errText} ${signalReason}`,
            );
      const canRetry = retryable && attempt <= maxAttempts;
      if (!canRetry) {
        err.details = {
          ...toRecord(err.details),
          retryAttempts: attempt,
          totalAttempts,
          status: statusCode || null,
          profile: route.profile,
          provider: route.provider,
        };
        const state = orchestrator.getRunState(sessionId);
        if (state.retry.active) {
          orchestrator.events.emit("auto_retry_end", sessionId, {
            success: false,
            attempt: state.retry.attempt,
            maxAttempts: state.retry.maxAttempts,
            finalError: errText,
          });
        }
        orchestrator.resetRetryState(sessionId);
        throw err;
      }

      const delayMs = computeRetryDelayMs(attempt);
      const next = orchestrator.updateRetryState(sessionId, {
        active: true,
        attempt,
        delayMs,
      });
      orchestrator.events.emit("auto_retry_start", sessionId, {
        attempt,
        maxAttempts: next.retry.maxAttempts,
        delayMs,
        status: statusCode || null,
        reason: errText,
      });
      await delay(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }

  const finalError = asRuntimeErrorWithMeta(
    lastError || new Error("LLM request failed"),
  );
  finalError.details = {
    ...toRecord(finalError.details),
    retryAttempts: totalAttempts,
    totalAttempts,
    profile: route.profile,
    provider: route.provider,
  };
  throw finalError;
}
