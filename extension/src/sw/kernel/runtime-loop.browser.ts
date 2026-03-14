import {
  BrainOrchestrator,
  type ExecuteCapability,
  type ExecuteMode,
  type ExecuteStepResult,
  type RuntimeView,
  type ToolContract,
  type ToolDefinition,
} from "./orchestrator.browser";
import { SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.browser";
import {
  buildAssistantContentBlocks,
  transformMessagesForLlm,
} from "./llm-message-model.browser";
import { decideProfileEscalation } from "./llm-profile-policy";
import { type LlmResolvedRoute } from "./llm-provider";
import { LlmProviderRegistry } from "./llm-provider-registry";
import { resolveLlmRoute } from "./llm-profile-resolver";
import { writeSessionMeta } from "./session-store.browser";
import {
  type BridgeConfig,
  type RuntimeInfraHandler,
} from "./runtime-infra.browser";
import {
  type CapabilityExecutionPolicy,
  type StepVerifyPolicy,
} from "./capability-policy";
import type { SkillMetadata } from "./skill-registry";
import {
  normalizeBrowserRuntimeStrategy,
  resolveBrowserRuntimeHint,
} from "./browser-runtime-strategy";
import { normalizeSkillCreateRequest } from "./skill-create";
import {
  dedupePromptContextRefs,
  extractPromptContextRefs,
  formatPromptContextRefSummary,
  normalizePromptContextRefs,
  rewritePromptWithContextRefPlaceholders,
  type PromptContextRefInput,
} from "../../shared/context-ref";
import {
  frameMatchesVirtualCapability,
  invokeVirtualFrame,
  isVirtualUri,
  shouldRouteFrameToBrowserVfs,
} from "./virtual-fs.browser";
import { createContextRefService } from "./context-ref/context-ref-service.browser";
import { createFilesystemInspectService } from "./context-ref/filesystem-inspect.browser";
import {
  buildAvailableSkillsSystemMessage,
  buildBrowserAgentSystemPromptBase,
  buildLlmMessagesFromContext,
  buildTaskProgressSystemMessage,
} from "./prompt/prompt-policy.browser";
import {
  nowIso,
  type SessionEntry,
  type SessionMeta,
  type StreamingBehavior,
} from "./types";
import {
  type HostedChatTurnResult,
} from "../../shared/cursor-help-web-shared";
import { normalizeCompactionSettings } from "../../shared/compaction";
import {
  createToolDispatcher,
  createRuntimeError,
  extractSkillReadContent,
  toBrowserUserDisplayPath,
  buildSkillReferenceDirectoryRef,
  buildSkillChildLocation,
  buildSkillPackageRootLocation,
  type ToolDispatchDeps,
} from "./loop-tool-dispatch";
import {
  buildLlmFailureSignature,
  buildLlmRoutePayload,
  computeRetryDelayMs,
  extractRetryDelayHintMs,
  isRetryableLlmStatus,
  readSessionLlmRoutePrefs,
  resolveAuxiliaryLlmRoute,
  resolvePrimaryLlmRoute,
  withSessionLlmRouteMeta,
} from "./loop-llm-route";
import {
  buildHostedChatEventPayload,
  hostedChatTurnToMessage,
  parseLlmMessageFromBody,
  readHostedChatTurnFromTransportStream,
  readLlmMessageFromSseStream,
  resolveRouteRuntimeKind,
} from "./loop-llm-stream";
import {
  normalizeSessionTitle,
  parseLlmContent,
  refreshSessionTitleAuto,
} from "./loop-session-title";
import {
  buildObserveProgressVerify,
  shouldVerifyStep,
  shouldAcquireLease,
  isToolCallRequiringBrowserProof,
  didToolProvideBrowserProof,
  mapToolErrorReasonToTerminalStatus,
} from "./loop-browser-proof";
import {
  buildFocusEscalationToolCall,
  parseToolCallArgs,
  buildToolFailurePayload,
  buildToolSuccessPayload,
} from "./loop-tool-display";

// ── Re-exports from shared modules (preserve public API) ────────────
export {
  type FailureReason,
  type ToolCallItem,
  type RuntimeErrorWithMeta,
  type RuntimeLoopController,
  type ToolRetryAction,
  type FailurePhase,
  type FailureCategory,
  type ResumeStrategy,
  type NoProgressReason,
  type BashExecOutcome,
  type RunStartInput,
  type RegenerateRunInput,
  type LlmRequestInput,
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  CAPABILITIES,
  CANONICAL_BROWSER_TOOL_NAMES,
  RUNTIME_EXECUTABLE_TOOL_NAMES,
  NO_PROGRESS_CONTINUE_BUDGET,
  BROWSER_PROOF_REQUIRED_TOOL_NAMES,
  MAX_LLM_RETRIES,
  MAX_DEBUG_CHARS,
  SESSION_TITLE_MIN,
  DEFAULT_LLM_TIMEOUT_MS,
  MIN_LLM_TIMEOUT_MS,
  MAX_LLM_TIMEOUT_MS,
  TOOL_AUTO_RETRY_BASE_DELAY_MS,
  TOOL_AUTO_RETRY_CAP_DELAY_MS,
  DEFAULT_LLM_MAX_RETRY_DELAY_MS,
  MIN_LLM_MAX_RETRY_DELAY_MS,
  MAX_LLM_MAX_RETRY_DELAY_MS,
  LLM_TRACE_BODY_PREVIEW_MAX_CHARS,
  LLM_TRACE_USER_SNIPPET_MAX_CHARS,
  MAX_PROMPT_SKILL_ITEMS,
  NO_PROGRESS_SIGNATURE_HISTORY_LIMIT,
} from "./loop-shared-types";
export {
  toRecord,
  clipText,
  safeStringify,
  stableHash,
  parsePositiveInt,
  normalizeIntInRange,
  asRuntimeErrorWithMeta,
  isPlainJsonRecord,
  normalizeErrorCode,
  normalizeSchemaRequiredList,
  readTopLevelConstraintRequiredSets,
  sanitizeLlmToolDefinitionForProvider,
  readContractExecution,
  normalizeToolCalls,
  normalizeToolArgsForSignature,
  normalizeVerifyExpect,
  inferSearchElementsFilter,
  scoreSearchNode,
  queryAllTabsForRuntime,
  getActiveTabIdForRuntime,
  readSharedTabIds,
  callInfra,
  extractLlmConfig,
  delay,
} from "./loop-shared-utils";
export {
  isRetryableToolErrorCode,
  shouldAutoReplayToolCall,
  computeToolRetryDelayMs,
  buildToolRetryHint,
  attachFailureProtocol,
  extractBashExecOutcome,
  buildBashExitFailureEnvelope,
  buildSkillScriptSandboxFailureEnvelope,
  buildStepFailureEnvelope,
  normalizeFailureReason,
} from "./loop-failure-protocol";

// ── Imports from shared modules (used within this file) ─────────────
import {
  type FailureReason,
  type ToolCallItem,
  type RuntimeErrorWithMeta,
  type RuntimeLoopController,
  type BashExecOutcome,
  type RunStartInput,
  type RegenerateRunInput,
  type LlmRequestInput,
  type NoProgressReason,
  CAPABILITIES,
  CANONICAL_BROWSER_TOOL_NAMES,
  RUNTIME_EXECUTABLE_TOOL_NAMES,
  NO_PROGRESS_CONTINUE_BUDGET,
  BROWSER_PROOF_REQUIRED_TOOL_NAMES,
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  MAX_LLM_RETRIES,
  MAX_DEBUG_CHARS,
  SESSION_TITLE_MIN,
  DEFAULT_LLM_TIMEOUT_MS,
  MIN_LLM_TIMEOUT_MS,
  MAX_LLM_TIMEOUT_MS,
  DEFAULT_LLM_MAX_RETRY_DELAY_MS,
  MIN_LLM_MAX_RETRY_DELAY_MS,
  MAX_LLM_MAX_RETRY_DELAY_MS,
  LLM_TRACE_BODY_PREVIEW_MAX_CHARS,
  LLM_TRACE_USER_SNIPPET_MAX_CHARS,
  MAX_PROMPT_SKILL_ITEMS,
  NO_PROGRESS_SIGNATURE_HISTORY_LIMIT,
} from "./loop-shared-types";
import {
  toRecord,
  clipText,
  safeStringify,
  stableHash,
  parsePositiveInt,
  normalizeIntInRange,
  asRuntimeErrorWithMeta,
  isPlainJsonRecord,
  normalizeErrorCode,
  normalizeSchemaRequiredList,
  readTopLevelConstraintRequiredSets,
  sanitizeLlmToolDefinitionForProvider,
  readContractExecution,
  normalizeToolCalls,
  normalizeToolArgsForSignature,
  normalizeVerifyExpect,
  inferSearchElementsFilter,
  scoreSearchNode,
  queryAllTabsForRuntime,
  getActiveTabIdForRuntime,
  readSharedTabIds,
  callInfra,
  extractLlmConfig,
  delay,
} from "./loop-shared-utils";
import {
  normalizeFailureReason,
} from "./loop-failure-protocol";

type JsonRecord = Record<string, unknown>;

const BUILTIN_BRIDGE_CAPABILITY_PROVIDERS: Array<{
  capability: ExecuteCapability;
  providerId: string;
}> = [];

const BUILTIN_SANDBOX_CAPABILITY_PROVIDERS: Array<{
  capability: ExecuteCapability;
  providerId: string;
}> = [];

const BUILTIN_BROWSER_CAPABILITY_PROVIDERS: Array<{
  capability: ExecuteCapability;
  providerId: string;
}> = [];

function estimateJsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).length;
  } catch {
    return 0;
  }
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const block = toRecord(item);
    if (typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (typeof block.input_text === "string") {
      parts.push(block.input_text);
      continue;
    }
    if (typeof block.content === "string") {
      parts.push(block.content);
    }
  }
  return parts.join("");
}

function sanitizePromptForTrace(text: string): string {
  return String(text || "")
    .replace(
      /<skill_command\b[\s\S]*?<\/skill_command>/gi,
      "[skill command omitted]",
    )
    .replace(/<skill\b[\s\S]*?<\/skill>/gi, "[skill omitted]");
}

function summarizeLlmRequestPayload(payload: JsonRecord): JsonRecord {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let messageChars = 0;
  let maxMessageChars = 0;
  let toolMessageCount = 0;
  let lastUserSnippet = "";

  for (const item of messages) {
    const message = toRecord(item);
    const role = String(message.role || "").trim();
    if (role === "tool") toolMessageCount += 1;
    const text = extractContentText(message.content);
    const chars = text.length;
    messageChars += chars;
    if (chars > maxMessageChars) maxMessageChars = chars;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = toRecord(messages[i]);
    if (String(message.role || "") !== "user") continue;
    const text = sanitizePromptForTrace(
      extractContentText(message.content),
    ).trim();
    if (!text) continue;
    lastUserSnippet = clipText(text, LLM_TRACE_USER_SNIPPET_MAX_CHARS);
    break;
  }

  return {
    messageCount: messages.length,
    messageChars,
    maxMessageChars,
    toolMessageCount,
    toolDefinitionCount: Array.isArray(payload.tools)
      ? payload.tools.length
      : 0,
    requestBytes: estimateJsonBytes(payload),
    stream: payload.stream === true,
    temperature:
      typeof payload.temperature === "number" ? payload.temperature : undefined,
    lastUserSnippet,
  };
}

function buildLlmRawTracePayload(input: {
  step: number;
  attempt: number;
  status: number;
  ok: boolean;
  body: string;
  retryDelayHintMs?: number | null;
  source?: string;
  contentType?: string;
}): JsonRecord {
  const body = String(input.body || "");
  return {
    step: input.step,
    attempt: input.attempt,
    status: input.status,
    ok: input.ok,
    retryDelayHintMs: input.retryDelayHintMs,
    bodyPreview: clipText(body, LLM_TRACE_BODY_PREVIEW_MAX_CHARS),
    bodyLength: body.length,
    bodyTruncated: body.length > LLM_TRACE_BODY_PREVIEW_MAX_CHARS,
    source: input.source || undefined,
    contentType: input.contentType || undefined,
  };
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

function normalizeTabIds(input: unknown[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of input) {
    const id = Number(raw);
    if (!Number.isInteger(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeStreamingBehavior(input: unknown): StreamingBehavior | null {
  const value = String(input || "").trim();
  if (value === "steer" || value === "followUp") return value;
  return null;
}

function extractTabIdsFromPrompt(prompt: string): number[] {
  const text = String(prompt || "");
  const ids: number[] = [];
  const seen = new Set<number>();
  const regex = /tabid\s*[:=]\s*(\d+)/gi;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) !== null) {
    const tabId = parsePositiveInt(match[1]);
    if (!tabId || seen.has(tabId)) continue;
    seen.add(tabId);
    ids.push(tabId);
  }
  return ids;
}


const NO_PROGRESS_VOLATILE_EVIDENCE_KEYS = new Set([
  "backendNodeId",
  "cmdId",
  "contentRuntimeVersion",
  "fallbackFrom",
  "lastSenderError",
  "leaseId",
  "modeUsed",
  "pageRuntimeVersion",
  "providerId",
  "ref",
  "requestId",
  "resolvedTool",
  "rpcId",
  "runtimeExpectedVersion",
  "runtimeVersion",
  "sessionId",
  "snapshotId",
  "stepRef",
  "tabId",
  "targetTabId",
  "toolCallId",
  "uid",
]);

function normalizeNoProgressEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const limit = 8;
    const items = value
      .slice(0, limit)
      .map((item) => normalizeNoProgressEvidenceValue(item));
    if (value.length > limit) items.push(`__truncated__:${value.length}`);
    return items;
  }
  if (typeof value === "string") return clipText(value, 240);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (NO_PROGRESS_VOLATILE_EVIDENCE_KEYS.has(key)) continue;
    const normalized = normalizeNoProgressEvidenceValue(source[key]);
    if (normalized === undefined) continue;
    out[key] = normalized;
  }
  return out;
}

function buildNoProgressEvidenceFingerprint(value: unknown): string {
  return safeStringify(normalizeNoProgressEvidenceValue(value), 1200);
}

function applyLatestUserPromptOverride(
  messages: JsonRecord[],
  prompt: string,
): JsonRecord[] {
  const promptText = String(prompt || "").trim();
  if (!promptText) return messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = toRecord(messages[i]);
    if (String(item.role || "") !== "user") continue;
    const next = [...messages];
    next[i] = {
      ...item,
      role: "user",
      content: promptText,
    };
    return next;
  }
  return [
    ...messages,
    {
      role: "user",
      content: promptText,
    },
  ];
}

async function requestCompactionSummaryFromLlm(input: {
  orchestrator: BrainOrchestrator;
  infra: RuntimeInfraHandler;
  providerRegistry: LlmProviderRegistry;
  sessionId: string;
  mode: "history" | "turn_prefix";
  promptText: string;
  maxTokens: number;
}): Promise<string> {
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
        throw new Error(
          `llm.before_request blocked: ${beforeRequest.reason || "blocked"}`,
        );
      }
      const patchedRequest = toRecord(beforeRequest.value.request);
      const requestUrl =
        String(patchedRequest.url || baseUrl).trim() || baseUrl;
      const requestPayload = toRecord(patchedRequest.payload);
      if (!Array.isArray(requestPayload.messages))
        requestPayload.messages = basePayload.messages;
      if (!String(requestPayload.model || "").trim())
        requestPayload.model = llmModel;
      if (typeof requestPayload.stream !== "boolean")
        requestPayload.stream = false;

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
        ...summarizeLlmRequestPayload(requestPayload),
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
        buildLlmRawTracePayload({
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
          if (delayMs > 0) await delay(delayMs);
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
        throw new Error(
          `llm.after_response blocked: ${afterResponse.reason || "blocked"}`,
        );
      }
      const patchedResponse = toRecord(afterResponse.value.response);
      const summary = parseLlmContent(patchedResponse).trim();
      if (!summary) {
        throw new Error("Compaction summary 为空");
      }
      return summary;
    } catch (error) {
      if (attempt >= totalAttempts) throw error;
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
        Number.isInteger(status) && status > 0
          ? isRetryableLlmStatus(status)
          : true;
      if (!retryableStatus) throw error;
      const fallbackDelayMs = Math.max(
        0,
        Math.min(llmMaxRetryDelayMs, computeRetryDelayMs(attempt)),
      );
      if (fallbackDelayMs > 0) await delay(fallbackDelayMs);
    }
  }

  throw new Error("compaction summary 请求失败");
}

export function createRuntimeLoopController(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
): RuntimeLoopController {
  const llmProviders = orchestrator.getLlmProviderRegistry();
  const filesystemInspect = createFilesystemInspectService({
    invokeHostTool: async (frame) =>
      toRecord(
        await callInfra(infra, {
          type: "bridge.invoke",
          payload: frame,
        }),
      ),
    invokeBrowserTool: async (frame) => toRecord(await invokeVirtualFrame(frame)),
  });
  const contextRefService = createContextRefService({
    inspect: filesystemInspect,
    readText: async (params) => {
      const result = await executeStep({
        sessionId: params.sessionId,
        capability: CAPABILITIES.fsRead,
        action: "invoke",
        args: {
          frame: {
            tool: "read",
            args: {
              path: params.path,
              runtime: params.runtime,
              ...(params.cwd ? { cwd: params.cwd } : {}),
              ...(params.offset !== undefined ? { offset: params.offset } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
            },
          },
        },
        verifyPolicy: "off",
      });
      if (!result.ok) {
        throw new Error(result.error || `上下文文件读取失败: ${params.path}`);
      }
      const payload = toRecord(toRecord(result.data).response);
      const data = toRecord(payload.data);
      return {
        path: String(data.path || params.path),
        content: String(data.content || ""),
        size: Math.max(0, Number(data.size || 0)),
        truncated: data.truncated === true,
      };
    },
  });

  orchestrator.onHook(
    "compaction.summary",
    async (payload) => {
      const promptText = String(payload.promptText || "").trim();
      if (!promptText) {
        return { action: "block", reason: "compaction.summary prompt 为空" };
      }
      try {
        const summary = await requestCompactionSummaryFromLlm({
          orchestrator,
          infra,
          providerRegistry: llmProviders,
          sessionId: String(payload.sessionId || ""),
          mode: payload.mode === "turn_prefix" ? "turn_prefix" : "history",
          promptText,
          maxTokens: Number(payload.maxTokens || 0),
        });
        return {
          action: "patch",
          patch: {
            summary,
          },
        };
      } catch (error) {
        return {
          action: "block",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { id: "runtime-loop.compaction.summary", priority: 100 },
  );

  const bridgeCapabilityInvoker = async (input: {
    sessionId: string;
    capability: ExecuteCapability;
    args: JsonRecord;
  }): Promise<JsonRecord> => {
    const frame = (() => {
      const rawFrame = toRecord(input.args.frame);
      if (Object.keys(rawFrame).length === 0) {
        throw new Error(
          `bridge capability provider 需要 args.frame: ${input.capability}`,
        );
      }
      return { ...rawFrame };
    })();
    if (!String(frame.tool || "").trim()) {
      throw new Error(
        `bridge capability provider 缺少 frame.tool: ${input.capability}`,
      );
    }
    if (!frame.sessionId) frame.sessionId = input.sessionId;
    const response = await callInfra(infra, {
      type: "bridge.invoke",
      payload: frame,
    });
    return {
      type: "invoke",
      response,
    };
  };

  const virtualFsCapabilityInvoker = async (input: {
    sessionId: string;
    capability: ExecuteCapability;
    args: JsonRecord;
  }): Promise<JsonRecord> => {
    const frame = (() => {
      const rawFrame = toRecord(input.args.frame);
      if (Object.keys(rawFrame).length === 0) {
        throw new Error(
          `virtual fs capability provider 需要 args.frame: ${input.capability}`,
        );
      }
      return { ...rawFrame };
    })();
    if (!String(frame.tool || "").trim()) {
      throw new Error(
        `virtual fs capability provider 缺少 frame.tool: ${input.capability}`,
      );
    }
    if (!frame.sessionId) frame.sessionId = input.sessionId;
    const data = await invokeVirtualFrame(frame);
    return {
      type: "invoke",
      response: {
        ok: true,
        data,
      },
    };
  };

  const ensureBuiltinBridgeCapabilityProviders = (): void => {
    for (const item of BUILTIN_BRIDGE_CAPABILITY_PROVIDERS) {
      const existed = orchestrator
        .getCapabilityProviders(item.capability)
        .some((provider) => provider.id === item.providerId);
      if (existed) continue;
      orchestrator.registerCapabilityProvider(item.capability, {
        id: item.providerId,
        mode: "bridge",
        priority: -100,
        canHandle: (stepInput) => {
          const frame = toRecord(stepInput.args?.frame);
          if (String(frame.tool || "").trim().length === 0) return false;
          return !shouldRouteFrameToBrowserVfs(frame);
        },
        invoke: async (stepInput) =>
          bridgeCapabilityInvoker({
            sessionId: stepInput.sessionId,
            capability: item.capability,
            args: toRecord(stepInput.args),
          }),
      });
    }
  };

  const ensureBuiltinSandboxCapabilityProviders = (): void => {
    for (const item of BUILTIN_SANDBOX_CAPABILITY_PROVIDERS) {
      const existed = orchestrator
        .getCapabilityProviders(item.capability)
        .some((provider) => provider.id === item.providerId);
      if (existed) continue;
      orchestrator.registerCapabilityProvider(item.capability, {
        id: item.providerId,
        mode: "script",
        priority: -80,
        canHandle: (stepInput) => {
          const frame = toRecord(stepInput.args?.frame);
          if (String(frame.tool || "").trim().length === 0) return false;
          if (!shouldRouteFrameToBrowserVfs(frame)) return false;
          return frameMatchesVirtualCapability(
            frame,
            String(item.capability || ""),
          );
        },
        invoke: async (stepInput) =>
          virtualFsCapabilityInvoker({
            sessionId: stepInput.sessionId,
            capability: item.capability,
            args: toRecord(stepInput.args),
          }),
      });
    }
  };

  async function withTabLease<T>(
    tabId: number,
    sessionId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const acquired = await callInfra(infra, {
      type: "lease.acquire",
      tabId,
      sessionId,
      ttlMs: 30_000,
    });
    if (acquired.ok !== true) {
      throw new Error(
        `lease.acquire 失败: ${String(acquired.reason || "unknown")}`,
      );
    }

    try {
      return await run();
    } finally {
      await infra.handleMessage({
        type: "lease.release",
        tabId,
        sessionId,
      });
    }
  }

  async function resolveRunScopeTabId(
    sessionId: string,
    explicitTabIdRaw: unknown,
  ): Promise<number | null> {
    const explicitTabId = parsePositiveInt(explicitTabIdRaw);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    const metadata = toRecord(toRecord(meta?.header).metadata);
    const currentPrimary = parsePositiveInt(metadata.primaryTabId);
    const sharedTabIds = readSharedTabIds(metadata.sharedTabs);

    let resolved = explicitTabId || currentPrimary;
    if (!resolved && sharedTabIds.length > 0) {
      resolved = sharedTabIds[0];
    }
    if (!resolved) {
      resolved = await getActiveTabIdForRuntime();
    }

    if (meta && resolved && currentPrimary !== resolved) {
      await writeSessionMeta(sessionId, {
        ...meta,
        header: {
          ...meta.header,
          metadata: {
            ...metadata,
            primaryTabId: resolved,
          },
        },
      });
    }
    return resolved;
  }


  const invokeBrowserSnapshotCapability = async (stepInput: {
    sessionId: string;
    action: string;
    args: JsonRecord;
  }): Promise<unknown> => {
    const payload = toRecord(stepInput.args);
    const options = toRecord(payload.options);
    const tabId = parsePositiveInt(payload.tabId || options.tabId);
    if (!tabId) {
      throw createRuntimeError("snapshot 需要有效 tabId", {
        code: "E_NO_TAB",
        retryable: true,
      });
    }
    const snapshotResult = (await callInfra(infra, {
      type: "cdp.snapshot",
      tabId,
      options: Object.keys(options).length > 0 ? options : payload,
    })) as JsonRecord;

    const failures = getActionFailures(stepInput.sessionId);
    if (failures.size > 0 && Array.isArray(snapshotResult.nodes)) {
      for (const node of snapshotResult.nodes as JsonRecord[]) {
        const uid = String(node.uid || node.ref || "");
        if (uid && failures.has(uid)) {
          node.failureCount = failures.get(uid);
        }
      }
      if (
        snapshotResult.compact &&
        typeof snapshotResult.compact === "string"
      ) {
        // regenerate compact to include [failed] markers if needed
        // but we rely on formatNodeCompact being called by infra
      }
    }
    return snapshotResult;
  };

  const invokeBrowserActionCapability = async (stepInput: {
    sessionId: string;
    action: string;
    args: JsonRecord;
    verifyPolicy?: StepVerifyPolicy;
    capability?: ExecuteCapability;
  }): Promise<unknown> => {
    const payload = toRecord(stepInput.args);
    const actionPayload =
      toRecord(payload.action) &&
      Object.keys(toRecord(payload.action)).length > 0
        ? toRecord(payload.action)
        : payload;
    const tabId = parsePositiveInt(payload.tabId || actionPayload.tabId);
    if (!tabId) {
      throw createRuntimeError("cdp 执行需要有效 tabId", {
        code: "E_NO_TAB",
        retryable: true,
      });
    }

    const cdpAction =
      Object.keys(toRecord(payload.action)).length > 0
        ? { ...toRecord(payload.action) }
        : { ...payload };
    if (
      !cdpAction.kind &&
      stepInput.action &&
      !stepInput.action.startsWith("cdp.")
    ) {
      cdpAction.kind = stepInput.action;
    }
    const kind = String(cdpAction.kind || "").trim();
    if (!kind) {
      throw createRuntimeError("cdp.action 缺少 kind", {
        code: "E_ARGS",
        retryable: false,
      });
    }

    const capabilityPolicy = orchestrator.resolveCapabilityPolicy(
      stepInput.capability,
    );
    const verifyPolicy =
      stepInput.verifyPolicy ||
      capabilityPolicy.defaultVerifyPolicy ||
      "on_critical";
    const verifyEnabled = shouldVerifyStep(kind, verifyPolicy);
    let preObserve: unknown = null;
    if (verifyEnabled) {
      preObserve = await callInfra(infra, {
        type: "cdp.observe",
        tabId,
      }).catch(() => null);
    }

    const actionResult = shouldAcquireLease(kind, capabilityPolicy)
      ? await withTabLease(tabId, stepInput.sessionId, async () => {
          return await callInfra(infra, {
            type: "cdp.action",
            tabId,
            sessionId: stepInput.sessionId,
            action: cdpAction,
          });
        })
      : await callInfra(infra, {
          type: "cdp.action",
          tabId,
          sessionId: stepInput.sessionId,
          action: cdpAction,
        });

    let verified = false;
    let verifyReason = "verify_policy_off";
    let verifyData: unknown = null;
    if (verifyEnabled) {
      try {
        const explicitExpect = normalizeVerifyExpect(
          payload.expect || actionPayload.expect || null,
        );
        if (explicitExpect) {
          if (
            explicitExpect.urlChanged === true &&
            toRecord(toRecord(preObserve).page).url
          ) {
            explicitExpect.previousUrl = String(
              toRecord(toRecord(preObserve).page).url || "",
            );
          }
          verifyData = await callInfra(infra, {
            type: "cdp.verify",
            tabId,
            action: { expect: explicitExpect },
            result: toRecord(actionResult).result || actionResult,
          });
        } else if (preObserve) {
          const afterObserve = await callInfra(infra, {
            type: "cdp.observe",
            tabId,
          });
          verifyData = buildObserveProgressVerify(preObserve, afterObserve);
        }
      } catch (verifyError) {
        const runtimeVerifyError = asRuntimeErrorWithMeta(verifyError);
        throw createRuntimeError(runtimeVerifyError.message, {
          code:
            normalizeErrorCode(runtimeVerifyError.code) || "E_VERIFY_EXECUTE",
          retryable: true,
          details: runtimeVerifyError.details,
        });
      }

      verified = toRecord(verifyData).ok === true;
      verifyReason = verifyData
        ? verified
          ? "verified"
          : "verify_failed"
        : "verify_skipped";

      if (
        !verified &&
        (kind === "click" || kind === "fill" || kind === "press")
      ) {
        const targetUid = String(cdpAction.uid || cdpAction.ref || "");
        if (targetUid) {
          trackActionFailure(stepInput.sessionId, targetUid);
        }
      }
    }

    let data: unknown = actionResult;
    if (
      verifyData &&
      data &&
      typeof data === "object" &&
      !Array.isArray(data)
    ) {
      data = {
        ...(data as JsonRecord),
        verify: verifyData,
      };
    }

    return {
      data,
      verified,
      verifyReason,
    };
  };

  const invokeBrowserVerifyCapability = async (stepInput: {
    sessionId: string;
    action: string;
    args: JsonRecord;
  }): Promise<unknown> => {
    const payload = toRecord(stepInput.args);
    const tabId = parsePositiveInt(
      payload.tabId || toRecord(payload.action).tabId,
    );
    if (!tabId) {
      throw createRuntimeError("browser_verify 需要有效 tabId", {
        code: "E_NO_TAB",
        retryable: true,
      });
    }
    const verifyAction = Object.keys(toRecord(payload.action)).length
      ? toRecord(payload.action)
      : {
          expect: Object.keys(toRecord(payload.expect)).length
            ? toRecord(payload.expect)
            : payload,
        };
    const verifyData = await callInfra(infra, {
      type: "cdp.verify",
      tabId,
      action: verifyAction,
      result: payload.result || null,
    });
    const verified = toRecord(verifyData).ok === true;
    return {
      data: verifyData,
      verified,
      verifyReason: verified ? "verified" : "verify_failed",
    };
  };

  const sessionActionFailures = new Map<string, Map<string, number>>();

  const trackActionFailure = (sessionId: string, targetUid: string) => {
    if (!targetUid) return;
    if (!sessionActionFailures.has(sessionId)) {
      sessionActionFailures.set(sessionId, new Map());
    }
    const counts = sessionActionFailures.get(sessionId)!;
    counts.set(targetUid, (counts.get(targetUid) || 0) + 1);
  };

  const getActionFailures = (sessionId: string): Map<string, number> => {
    return sessionActionFailures.get(sessionId) || new Map();
  };

  const clearActionFailures = (sessionId: string) => {
    sessionActionFailures.delete(sessionId);
  };

  const ensureBuiltinBrowserCapabilityProviders = (): void => {
    for (const item of BUILTIN_BROWSER_CAPABILITY_PROVIDERS) {
      const existed = orchestrator
        .getCapabilityProviders(item.capability)
        .some((provider) => provider.id === item.providerId);
      if (existed) continue;
      orchestrator.registerCapabilityProvider(item.capability, {
        id: item.providerId,
        mode: "cdp",
        priority: -100,
        invoke: async (stepInput) => {
          const input = {
            sessionId: stepInput.sessionId,
            action: String(stepInput.action || "").trim(),
            args: toRecord(stepInput.args),
            verifyPolicy: stepInput.verifyPolicy,
            capability: stepInput.capability,
          };
          if (item.capability === CAPABILITIES.browserSnapshot) {
            return await invokeBrowserSnapshotCapability(input);
          }
          if (item.capability === CAPABILITIES.browserAction) {
            return await invokeBrowserActionCapability(input);
          }
          return await invokeBrowserVerifyCapability(input);
        },
      });
    }
  };

  const ensureBuiltinCapabilityPlugins = (): void => {
    type CapabilityStepInput = {
      sessionId: string;
      action?: string;
      capability?: ExecuteCapability;
      verifyPolicy?: StepVerifyPolicy;
      args?: JsonRecord;
    };

    interface BuiltinCapabilityPluginInput {
      pluginId: string;
      pluginName: string;
      capability: ExecuteCapability;
      providerId: string;
      mode: ExecuteMode;
      priority: number;
      canHandle?: (stepInput: CapabilityStepInput) => boolean;
      invoke: (stepInput: CapabilityStepInput) => Promise<unknown>;
    }

    const hasPlugin = (pluginId: string): boolean =>
      orchestrator
        .listPlugins()
        .some((item) => String(item.id || "").trim() === pluginId);

    const registerBuiltinCapabilityPlugin = (
      spec: BuiltinCapabilityPluginInput,
    ): void => {
      if (hasPlugin(spec.pluginId)) return;
      orchestrator.registerPlugin(
        {
          manifest: {
            id: spec.pluginId,
            name: spec.pluginName,
            version: "1.0.0",
            permissions: {
              capabilities: [spec.capability],
            },
          },
          providers: {
            capabilities: {
              [spec.capability]: {
                id: spec.providerId,
                mode: spec.mode,
                priority: spec.priority,
                ...(spec.canHandle ? { canHandle: spec.canHandle } : {}),
                invoke: spec.invoke,
              },
            },
          },
        },
        { enable: true },
      );
    };

    const createFrameCanHandle = (
      capability: ExecuteCapability,
      runtime: "bridge" | "sandbox",
    ) => {
      return (stepInput: CapabilityStepInput): boolean => {
        const frame = toRecord(toRecord(stepInput.args).frame);
        if (!String(frame.tool || "").trim()) return false;
        if (runtime === "bridge") {
          if (shouldRouteFrameToBrowserVfs(frame)) return false;
        } else if (!shouldRouteFrameToBrowserVfs(frame)) {
          return false;
        }
        return frameMatchesVirtualCapability(frame, capability);
      };
    };

    const fileCapabilitySpecs: Array<{
      capability: ExecuteCapability;
      bridge: { pluginId: string; pluginName: string; providerId: string };
      sandbox: { pluginId: string; pluginName: string; providerId: string };
    }> = [
      {
        capability: CAPABILITIES.processExec,
        bridge: {
          pluginId: "runtime.builtin.plugin.capability.process.exec.bridge",
          pluginName: "builtin-process-exec-bridge",
          providerId: "runtime.builtin.capability.process.exec.bridge",
        },
        sandbox: {
          pluginId: "runtime.builtin.plugin.capability.process.exec.sandbox",
          pluginName: "builtin-process-exec-sandbox",
          providerId:
            "runtime.builtin.plugin.capability.process.exec.sandbox.provider",
        },
      },
      {
        capability: CAPABILITIES.fsRead,
        bridge: {
          pluginId: "runtime.builtin.plugin.capability.fs.read.bridge",
          pluginName: "builtin-fs-read-bridge",
          providerId: "runtime.builtin.capability.fs.read.bridge",
        },
        sandbox: {
          pluginId: "runtime.builtin.plugin.capability.fs.read.sandbox",
          pluginName: "builtin-fs-read-sandbox",
          providerId:
            "runtime.builtin.plugin.capability.fs.read.sandbox.provider",
        },
      },
      {
        capability: CAPABILITIES.fsWrite,
        bridge: {
          pluginId: "runtime.builtin.plugin.capability.fs.write.bridge",
          pluginName: "builtin-fs-write-bridge",
          providerId: "runtime.builtin.capability.fs.write.bridge",
        },
        sandbox: {
          pluginId: "runtime.builtin.plugin.capability.fs.write.sandbox",
          pluginName: "builtin-fs-write-sandbox",
          providerId:
            "runtime.builtin.plugin.capability.fs.write.sandbox.provider",
        },
      },
      {
        capability: CAPABILITIES.fsEdit,
        bridge: {
          pluginId: "runtime.builtin.plugin.capability.fs.edit.bridge",
          pluginName: "builtin-fs-edit-bridge",
          providerId: "runtime.builtin.capability.fs.edit.bridge",
        },
        sandbox: {
          pluginId: "runtime.builtin.plugin.capability.fs.edit.sandbox",
          pluginName: "builtin-fs-edit-sandbox",
          providerId:
            "runtime.builtin.plugin.capability.fs.edit.sandbox.provider",
        },
      },
    ];

    for (const spec of fileCapabilitySpecs) {
      registerBuiltinCapabilityPlugin({
        pluginId: spec.bridge.pluginId,
        pluginName: spec.bridge.pluginName,
        capability: spec.capability,
        providerId: spec.bridge.providerId,
        mode: "bridge",
        priority: -100,
        canHandle: createFrameCanHandle(spec.capability, "bridge"),
        invoke: async (stepInput) =>
          bridgeCapabilityInvoker({
            sessionId: stepInput.sessionId,
            capability: spec.capability,
            args: toRecord(stepInput.args),
          }),
      });
      registerBuiltinCapabilityPlugin({
        pluginId: spec.sandbox.pluginId,
        pluginName: spec.sandbox.pluginName,
        capability: spec.capability,
        providerId: spec.sandbox.providerId,
        mode: "script",
        priority: -80,
        canHandle: createFrameCanHandle(spec.capability, "sandbox"),
        invoke: async (stepInput) =>
          virtualFsCapabilityInvoker({
            sessionId: stepInput.sessionId,
            capability: spec.capability,
            args: toRecord(stepInput.args),
          }),
      });
    }

    const createBrowserCapabilityInput = (stepInput: CapabilityStepInput) => ({
      sessionId: stepInput.sessionId,
      action: String(stepInput.action || "").trim(),
      args: toRecord(stepInput.args),
      verifyPolicy: stepInput.verifyPolicy,
      capability: stepInput.capability,
    });

    const browserCapabilitySpecs: Array<{
      pluginId: string;
      pluginName: string;
      capability: ExecuteCapability;
      providerId: string;
      invoke: (input: {
        sessionId: string;
        action: string;
        args: JsonRecord;
        verifyPolicy?: StepVerifyPolicy;
        capability?: ExecuteCapability;
      }) => Promise<unknown>;
    }> = [
      {
        pluginId: "runtime.builtin.plugin.capability.browser.snapshot.cdp",
        pluginName: "builtin-browser-snapshot-cdp",
        capability: CAPABILITIES.browserSnapshot,
        providerId: "runtime.builtin.capability.browser.snapshot.cdp",
        invoke: invokeBrowserSnapshotCapability,
      },
      {
        pluginId: "runtime.builtin.plugin.capability.browser.action.cdp",
        pluginName: "builtin-browser-action-cdp",
        capability: CAPABILITIES.browserAction,
        providerId:
          "runtime.builtin.plugin.capability.browser.action.cdp.provider",
        invoke: invokeBrowserActionCapability,
      },
      {
        pluginId: "runtime.builtin.plugin.capability.browser.verify.cdp",
        pluginName: "builtin-browser-verify-cdp",
        capability: CAPABILITIES.browserVerify,
        providerId: "runtime.builtin.capability.browser.verify.cdp",
        invoke: invokeBrowserVerifyCapability,
      },
    ];

    for (const spec of browserCapabilitySpecs) {
      registerBuiltinCapabilityPlugin({
        pluginId: spec.pluginId,
        pluginName: spec.pluginName,
        capability: spec.capability,
        providerId: spec.providerId,
        mode: "cdp",
        priority: -100,
        invoke: async (stepInput) =>
          spec.invoke(createBrowserCapabilityInput(stepInput)),
      });
    }
  };

  ensureBuiltinCapabilityPlugins();
  ensureBuiltinBridgeCapabilityProviders();
  ensureBuiltinSandboxCapabilityProviders();
  ensureBuiltinBrowserCapabilityProviders();

  async function executeStep(input: {
    sessionId: string;
    mode?: ExecuteMode;
    capability?: ExecuteCapability;
    action: string;
    args?: JsonRecord;
    verifyPolicy?: StepVerifyPolicy;
  }): Promise<ExecuteStepResult> {
    const sessionId = String(input.sessionId || "").trim();
    const normalizedMode = ["script", "cdp", "bridge"].includes(
      String(input.mode || "").trim(),
    )
      ? (String(input.mode || "").trim() as ExecuteMode)
      : undefined;
    const normalizedCapability =
      String(input.capability || "").trim() || undefined;
    const capabilityPolicy =
      orchestrator.resolveCapabilityPolicy(normalizedCapability);
    const effectiveVerifyPolicy: StepVerifyPolicy =
      input.verifyPolicy ||
      capabilityPolicy.defaultVerifyPolicy ||
      "on_critical";
    const normalizedAction = String(input.action || "").trim();
    const payload = toRecord(input.args);
    const actionPayload =
      toRecord(payload.action) &&
      Object.keys(toRecord(payload.action)).length > 0
        ? toRecord(payload.action)
        : payload;
    const tabId = parsePositiveInt(payload.tabId || actionPayload.tabId);
    const capabilityProviderId = normalizedCapability
      ? String(
          orchestrator.getCapabilityProvider(normalizedCapability)?.id || "",
        )
      : "";

    if (!normalizedMode && !normalizedCapability) {
      return {
        ok: false,
        modeUsed: "bridge",
        verified: false,
        error: "mode 或 capability 至少需要一个",
      };
    }
    if (!normalizedAction) {
      return {
        ok: false,
        modeUsed: normalizedMode || "bridge",
        verified: false,
        error: "action 不能为空",
      };
    }

    if (
      normalizedCapability &&
      orchestrator.hasCapabilityProvider(normalizedCapability)
    ) {
      const capabilityMode =
        normalizedMode ||
        orchestrator.resolveModeForCapability(normalizedCapability);
      if (!capabilityMode) {
        const result: ExecuteStepResult = {
          ok: false,
          modeUsed: "bridge",
          capabilityUsed: normalizedCapability,
          providerId: capabilityProviderId || undefined,
          verified: false,
          error: `capability provider 已注册但缺少 mode: ${normalizedCapability}`,
          errorCode: "E_RUNTIME_NOT_READY",
          retryable: true,
        };
        orchestrator.events.emit("step_execute", sessionId, {
          mode: "bridge",
          capability: normalizedCapability,
          action: normalizedAction,
          providerId: capabilityProviderId,
        });
        orchestrator.events.emit("step_execute_result", sessionId, {
          ok: result.ok,
          modeUsed: result.modeUsed,
          capabilityUsed: result.capabilityUsed || "",
          providerId: result.providerId || capabilityProviderId,
          verifyReason: result.verifyReason || "",
          verified: result.verified,
          error: result.error || "",
          errorCode: result.errorCode || "",
          retryable: result.retryable === true,
        });
        return result;
      }
      orchestrator.events.emit("step_execute", sessionId, {
        mode: capabilityMode,
        capability: normalizedCapability,
        action: normalizedAction,
        providerId: capabilityProviderId,
      });
      const result = await orchestrator.executeStep({
        sessionId,
        mode: capabilityMode,
        capability: normalizedCapability,
        action: normalizedAction,
        args: payload,
        verifyPolicy: effectiveVerifyPolicy,
      });
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        capabilityUsed: result.capabilityUsed || normalizedCapability,
        providerId: result.providerId || capabilityProviderId,
        fallbackFrom: result.fallbackFrom,
        verified: result.verified,
        verifyReason: result.verifyReason,
        error: result.error,
      });
      return {
        ...result,
        capabilityUsed: result.capabilityUsed || normalizedCapability,
        providerId: result.providerId || capabilityProviderId || undefined,
      };
    }

    if (normalizedCapability) {
      const result: ExecuteStepResult = {
        ok: false,
        modeUsed: "bridge",
        capabilityUsed: normalizedCapability,
        providerId: capabilityProviderId || undefined,
        verified: false,
        error: `capability provider 未就绪: ${normalizedCapability}`,
        errorCode: "E_RUNTIME_NOT_READY",
        retryable: true,
      };
      orchestrator.events.emit("step_execute", sessionId, {
        mode: "bridge",
        capability: normalizedCapability,
        action: normalizedAction,
        providerId: capabilityProviderId,
      });
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        capabilityUsed: result.capabilityUsed || "",
        providerId: result.providerId || capabilityProviderId,
        verifyReason: result.verifyReason || "",
        verified: result.verified,
        error: result.error || "",
        errorCode: result.errorCode || "",
        retryable: result.retryable === true,
      });
      return result;
    }

    const executionMode = normalizedMode;
    if (!executionMode) {
      return {
        ok: false,
        modeUsed: "bridge",
        verified: false,
        error: normalizedCapability
          ? `capability provider 未注册或未就绪: ${normalizedCapability}`
          : "mode 必须是 script/cdp/bridge",
      };
    }

    const modeProvider = orchestrator.getToolProvider(executionMode);
    const modeProviderId = String(modeProvider?.id || "");
    orchestrator.events.emit("step_execute", sessionId, {
      mode: executionMode,
      capability: normalizedCapability,
      action: normalizedAction,
      providerId: modeProviderId,
    });

    // mode provider 已注册时，统一走 orchestrator 执行链，确保 plugin hooks/provider override 生效。
    if (modeProvider) {
      const result = await orchestrator.executeStep({
        sessionId,
        mode: executionMode,
        capability: normalizedCapability,
        action: normalizedAction,
        args: payload,
        verifyPolicy: effectiveVerifyPolicy,
      });
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        capabilityUsed: result.capabilityUsed || normalizedCapability || "",
        providerId: result.providerId || modeProviderId,
        fallbackFrom: result.fallbackFrom,
        verified: result.verified,
        verifyReason: result.verifyReason,
        error: result.error,
        errorCode: result.errorCode || "",
        retryable: result.retryable === true,
      });
      return {
        ...result,
        capabilityUsed: result.capabilityUsed || normalizedCapability,
        providerId: result.providerId || modeProviderId || undefined,
      };
    }

    const runMode = async (targetMode: ExecuteMode): Promise<unknown> => {
      if (targetMode === "bridge") {
        const frame: JsonRecord = (() => {
          const rawFrame = toRecord(payload.frame);
          if (Object.keys(rawFrame).length > 0) return { ...rawFrame };
          return {
            tool: String(payload.tool || normalizedAction || "").trim(),
            args:
              Object.keys(toRecord(payload.invokeArgs)).length > 0
                ? toRecord(payload.invokeArgs)
                : toRecord(payload.args),
          };
        })();
        if (!String(frame.tool || "").trim())
          throw new Error("bridge 执行缺少 tool");
        if (!frame.sessionId) frame.sessionId = sessionId;
        const response = await callInfra(infra, {
          type: "bridge.invoke",
          payload: frame,
        });
        return {
          type: "invoke",
          response,
        };
      }

      if (!tabId) throw new Error(`${targetMode} 执行需要有效 tabId`);

      if (
        normalizedAction === "snapshot" ||
        normalizedAction === "cdp.snapshot"
      ) {
        return await callInfra(infra, {
          type: "cdp.snapshot",
          tabId,
          options:
            toRecord(payload.options) &&
            Object.keys(toRecord(payload.options)).length > 0
              ? toRecord(payload.options)
              : payload,
        });
      }
      if (
        normalizedAction === "observe" ||
        normalizedAction === "cdp.observe"
      ) {
        return await callInfra(infra, {
          type: "cdp.observe",
          tabId,
        });
      }
      if (normalizedAction === "verify" || normalizedAction === "cdp.verify") {
        const verifyAction = Object.keys(toRecord(payload.action)).length
          ? toRecord(payload.action)
          : {
              expect: Object.keys(toRecord(payload.expect)).length
                ? toRecord(payload.expect)
                : payload,
            };
        return await callInfra(infra, {
          type: "cdp.verify",
          tabId,
          action: verifyAction,
          result: payload.result || null,
        });
      }

      if (targetMode === "script") {
        const expression = String(
          payload.expression || payload.script || "",
        ).trim();
        if (!expression) throw new Error("script 模式缺少 expression");
        return await callInfra(infra, {
          type: "cdp.execute",
          tabId,
          action: {
            type: "runtime.evaluate",
            expression,
            returnByValue: payload.returnByValue !== false,
          },
        });
      }

      const cdpAction =
        Object.keys(toRecord(payload.action)).length > 0
          ? { ...toRecord(payload.action) }
          : { ...payload };
      if (
        !cdpAction.kind &&
        normalizedAction &&
        !normalizedAction.startsWith("cdp.")
      ) {
        cdpAction.kind = normalizedAction;
      }
      const kind = String(cdpAction.kind || "").trim();
      if (!kind) throw new Error("cdp.action 缺少 kind");

      if (shouldAcquireLease(kind, capabilityPolicy)) {
        return await withTabLease(tabId, sessionId, async () => {
          return await callInfra(infra, {
            type: "cdp.action",
            tabId,
            sessionId,
            action: cdpAction,
          });
        });
      }

      return await callInfra(infra, {
        type: "cdp.action",
        tabId,
        sessionId,
        action: cdpAction,
      });
    };

    let modeUsed: ExecuteMode = executionMode;
    let providerId: string | undefined = modeProviderId || undefined;
    const fallbackFrom: ExecuteMode | undefined = undefined;
    let data: unknown;
    let preObserve: unknown = null;
    const verifyEnabled = shouldVerifyStep(
      String(actionPayload.kind || normalizedAction),
      effectiveVerifyPolicy,
    );

    if (
      verifyEnabled &&
      tabId &&
      executionMode !== "bridge" &&
      normalizedAction !== "verify" &&
      normalizedAction !== "cdp.verify"
    ) {
      preObserve = await callInfra(infra, {
        type: "cdp.observe",
        tabId,
      }).catch(() => null);
    }

    try {
      data = await runMode(executionMode);
    } catch (error) {
      const runtimeError = asRuntimeErrorWithMeta(error);
      const result: ExecuteStepResult = {
        ok: false,
        modeUsed,
        capabilityUsed: normalizedCapability,
        providerId,
        verified: false,
        error: runtimeError.message,
        errorCode: normalizeErrorCode(runtimeError.code),
        errorDetails: runtimeError.details,
        retryable: runtimeError.retryable,
      };
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        capabilityUsed: result.capabilityUsed || "",
        providerId: result.providerId || "",
        verifyReason: result.verifyReason || "",
        verified: result.verified,
        error: result.error || "",
        errorCode: result.errorCode || "",
        retryable: result.retryable === true,
      });
      return result;
    }

    let verified = false;
    let verifyReason = "verify_policy_off";
    try {
      if (verifyEnabled) {
        if (modeUsed === "bridge") {
          verifyReason = "verify_not_supported_for_bridge";
        } else if (!tabId) {
          verifyReason = "verify_missing_tab_id";
        } else if (
          normalizedAction === "verify" ||
          normalizedAction === "cdp.verify"
        ) {
          verified = toRecord(data).ok === true;
          verifyReason = verified ? "verified" : "verify_failed";
        } else {
          const explicitExpect = normalizeVerifyExpect(
            payload.expect || actionPayload.expect || null,
          );
          let verifyData: unknown = null;
          if (explicitExpect) {
            if (
              explicitExpect.urlChanged === true &&
              toRecord(toRecord(preObserve).page).url
            ) {
              explicitExpect.previousUrl = String(
                toRecord(toRecord(preObserve).page).url || "",
              );
            }
            verifyData = await callInfra(infra, {
              type: "cdp.verify",
              tabId,
              action: { expect: explicitExpect },
              result: toRecord(data).result || data,
            });
          } else if (preObserve) {
            const afterObserve = await callInfra(infra, {
              type: "cdp.observe",
              tabId,
            });
            verifyData = buildObserveProgressVerify(preObserve, afterObserve);
          }

          verified = toRecord(verifyData).ok === true;
          verifyReason = verifyData
            ? verified
              ? "verified"
              : "verify_failed"
            : "verify_skipped";
          if (
            verifyData &&
            data &&
            typeof data === "object" &&
            !Array.isArray(data)
          ) {
            data = {
              ...(data as JsonRecord),
              verify: verifyData,
            };
          }
        }
      }
    } catch (verifyError) {
      const runtimeVerifyError = asRuntimeErrorWithMeta(verifyError);
      const result: ExecuteStepResult = {
        ok: false,
        modeUsed,
        providerId,
        fallbackFrom,
        verified: false,
        error: runtimeVerifyError.message,
        errorCode:
          normalizeErrorCode(runtimeVerifyError.code) || "E_VERIFY_EXECUTE",
        errorDetails: runtimeVerifyError.details,
        retryable: true,
      };
      orchestrator.events.emit("step_execute_result", sessionId, {
        ok: result.ok,
        modeUsed: result.modeUsed,
        providerId: result.providerId || "",
        fallbackFrom: result.fallbackFrom || "",
        verifyReason: result.verifyReason || "",
        verified: result.verified,
        error: result.error || "",
        errorCode: result.errorCode || "",
        retryable: result.retryable === true,
      });
      return result;
    }

    const result: ExecuteStepResult = {
      ok: true,
      modeUsed,
      capabilityUsed: normalizedCapability,
      providerId,
      fallbackFrom,
      verified,
      verifyReason,
      data,
    };
    orchestrator.events.emit("step_execute_result", sessionId, {
      ok: result.ok,
      modeUsed: result.modeUsed,
      capabilityUsed: result.capabilityUsed || "",
      providerId: result.providerId || "",
      fallbackFrom: result.fallbackFrom || "",
      verifyReason: result.verifyReason || "",
      verified: result.verified,
    });
    return result;
  }


  orchestrator.setSkillContentReader(async (input) => {
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) {
      throw new Error("skill.resolve 需要 sessionId 以绑定当前会话 capability");
    }
    const location = String(input.location || "").trim();
    const runtime = isVirtualUri(location) ? "browser" : undefined;
    const readCapability =
      String(input.capability || CAPABILITIES.fsRead).trim() ||
      CAPABILITIES.fsRead;
    const result = await executeStep({
      sessionId,
      capability: readCapability as ExecuteCapability,
      action: "invoke",
      args: {
        path: location,
        frame: {
          tool: "read",
          args: {
            path: location,
            ...(runtime ? { runtime } : {}),
          },
        },
      },
      verifyPolicy: "off",
    });
    if (!result.ok) {
      throw new Error(result.error || `文件读取失败: ${location}`);
    }
    return extractSkillReadContent(result.data);
  });

  orchestrator.setSkillPromptAugmenter(async (input) => {
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) return "";
    const referencesDirRef = buildSkillReferenceDirectoryRef(input.skill);
    if (!referencesDirRef) return "";
    const resolvedRefs = await contextRefService.resolveContextRefs({
      sessionId,
      sessionMeta: null,
      refs: [referencesDirRef],
    });
    const invalidFailure = resolvedRefs
      .filter((item) => item.kind === "invalid")
      .map((item) => String(item.error || `上下文引用失败: ${item.displayPath}`))
      .join("\n");
    if (invalidFailure) {
      throw new Error(invalidFailure);
    }
    const availableRefs = resolvedRefs.filter((item) => item.kind !== "missing");
    if (availableRefs.length === 0) return "";
    const materializedRefs = await contextRefService.materializeContextRefs({
      sessionId,
      refs: availableRefs,
    });
    const contextPrefix = contextRefService.buildContextPromptPrefix({
      refs: availableRefs,
      materialized: materializedRefs,
    });
    if (!contextPrefix) return "";
    return [
      "<skill_resources>",
      "以下是该 skill package 内可按需读取的本地 references 索引；仅在需要时再调用 read_skill_reference 读取具体文件。",
      contextPrefix,
      "</skill_resources>",
    ].join("\n");
  });

  // Tool dispatch functions extracted to loop-tool-dispatch.ts
  const { buildToolPlan, dispatchToolPlan, executeToolCall, getToolPlanTabId, mergeStepRef } = createToolDispatcher({
    orchestrator,
    infra,
    executeStep,
  });

  function listRuntimeLlmToolDefinitions(
    toolScope: "all" | "browser_only" = "all",
  ): ToolDefinition[] {
    return orchestrator
      .listLlmToolDefinitions()
      .filter((definition) => {
        const toolName = String(definition.function?.name || "").trim();
        if (!toolName) return false;
        const contract = orchestrator.resolveToolContract(toolName);
        const canonical = String(contract?.name || toolName).trim();
        if (RUNTIME_EXECUTABLE_TOOL_NAMES.has(canonical)) return true;
        const execution = readContractExecution(contract);
        if (!execution) return false;
        return orchestrator.hasCapabilityProvider(execution.capability);
      })
      .filter((definition) => {
        if (toolScope !== "browser_only") return true;
        const toolName = String(definition.function?.name || "").trim();
        const contract = orchestrator.resolveToolContract(toolName);
        const canonical = String(contract?.name || toolName).trim();
        if (
          CANONICAL_BROWSER_TOOL_NAMES.includes(
            canonical as (typeof CANONICAL_BROWSER_TOOL_NAMES)[number],
          )
        ) {
          return true;
        }
        if (canonical.startsWith("browser_")) return true;
        const execution = readContractExecution(contract);
        if (!execution) return false;
        if (execution.mode === "cdp") return true;
        return String(execution.capability || "").startsWith("browser.");
      });
  }

  async function buildResolvedSystemPrompt(input: {
    config: BridgeConfig;
    sessionId: string;
    sessionMeta: SessionMeta | null;
    toolDefinitions?: ToolDefinition[];
  }): Promise<string> {
    const toolDefinitions = Array.isArray(input.toolDefinitions)
      ? input.toolDefinitions
      : [];
    const overridePrompt = String(input.config.llmSystemPromptCustom || "");
    if (!overridePrompt.trim()) {
      return buildBrowserAgentSystemPromptBase(toolDefinitions);
    }

    const parsedRefs = extractPromptContextRefs(overridePrompt, "system_prompt");
    if (parsedRefs.refs.length === 0) {
      return overridePrompt;
    }

    const resolvedRefs = await contextRefService.resolveContextRefs({
      sessionId: input.sessionId,
      sessionMeta: input.sessionMeta,
      refs: parsedRefs.refs,
    });
    const failureMessage =
      contextRefService.buildContextRefFailureMessage(resolvedRefs);
    if (failureMessage) {
      throw new Error(failureMessage);
    }

    const materializedRefs = await contextRefService.materializeContextRefs({
      sessionId: input.sessionId,
      refs: resolvedRefs,
    });
    const contextPrefix = contextRefService.buildContextPromptPrefix({
      refs: resolvedRefs,
      materialized: materializedRefs,
    });
    const promptBody = rewritePromptWithContextRefPlaceholders(
      overridePrompt,
      resolvedRefs,
    );
    return [
      contextPrefix,
      `<system_prompt>\n${promptBody || "请结合以上 system prompt 上下文约束执行。"}\n</system_prompt>`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function requestLlmWithRetry(
    input: LlmRequestInput,
  ): Promise<JsonRecord> {
    const { sessionId, route, providerRegistry, step, messages } = input;
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
        const llmToolDefs = listRuntimeLlmToolDefinitions(toolScope).map(
          (definition) =>
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
        if (!requestPayload.tool_choice)
          requestPayload.tool_choice = toolChoice;
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
          source: isHostedChatRoute
            ? "hosted_chat_transport"
            : "llm_provider",
          ...summarizeLlmRequestPayload(requestPayload),
        });

        const resp = await provider.send({
          sessionId,
          step,
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
            source: isHostedChatRoute
              ? "hosted_chat_transport"
              : "llm_provider",
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

  async function runAgentLoop(
    sessionId: string,
    prompt: string,
  ): Promise<void> {
    const stateAtStart = orchestrator.getRunState(sessionId);
    if (stateAtStart.stopped) {
      orchestrator.setRunning(sessionId, false);
      orchestrator.events.emit("loop_skip_stopped", sessionId, {
        reason: "stopped_before_run",
      });
      return;
    }

    const cfgRaw = await callInfra(infra, { type: "config.get" });
    const config = extractLlmConfig(cfgRaw);
    orchestrator.updateCompactionSettings(config.compaction);
    const maxLoopSteps = normalizeIntInRange(config.maxSteps, 100, 1, 500);
    const sessionMeta = await orchestrator.sessions.getMeta(sessionId);
    const routePrefs = readSessionLlmRoutePrefs(sessionMeta);
    const routeResolved = resolvePrimaryLlmRoute(config, routePrefs);
    if (!routeResolved.ok) {
      const text = routeResolved.message;
      orchestrator.events.emit("llm.route.blocked", sessionId, {
        reason: routeResolved.reason,
        profile: routeResolved.profile,
        role: routeResolved.role,
      });
      orchestrator.events.emit("llm.skipped", sessionId, {
        reason: routeResolved.reason,
        profile: routeResolved.profile,
        role: routeResolved.role,
      });
      await orchestrator.sessions.appendMessage({
        sessionId,
        role: "assistant",
        text,
      });
      orchestrator.setRunning(sessionId, false);
      orchestrator.events.emit("loop_done", sessionId, {
        status: "failed_execute",
        llmSteps: 0,
        toolSteps: 0,
      });
      return;
    }
    let activeRoute = routeResolved.route;
    if (!llmProviders.has(activeRoute.provider)) {
      const text = `执行失败：未找到 LLM provider（${activeRoute.provider}）。`;
      orchestrator.events.emit("llm.route.blocked", sessionId, {
        reason: "provider_not_found",
        ...buildLlmRoutePayload(activeRoute),
      });
      orchestrator.events.emit("llm.skipped", sessionId, {
        reason: "provider_not_found",
        ...buildLlmRoutePayload(activeRoute),
      });
      await orchestrator.sessions.appendMessage({
        sessionId,
        role: "assistant",
        text,
      });
      orchestrator.setRunning(sessionId, false);
      orchestrator.events.emit("loop_done", sessionId, {
        status: "failed_execute",
        llmSteps: 0,
        toolSteps: 0,
      });
      return;
    }
    orchestrator.updateRetryState(sessionId, {
      maxAttempts: activeRoute.llmRetryMaxAttempts,
    });

    orchestrator.events.emit("loop_start", sessionId, {
      prompt: clipText(sanitizePromptForTrace(prompt), 3000),
    });
    orchestrator.events.emit(
      "llm.route.selected",
      sessionId,
      buildLlmRoutePayload(activeRoute, { source: "run_start" }),
    );
    if (sessionMeta) {
      try {
        await writeSessionMeta(
          sessionId,
          withSessionLlmRouteMeta(sessionMeta, activeRoute),
        );
      } catch {
        // ignore metadata write failures
      }
    }

    let llmStep = 0;
    let toolStep = 0;
    let finalStatus = "done";
    const llmFailureBySignature = new Map<string, number>();
    const focusEscalationReplayKeys = new Set<string>();
    const noProgressHits = new Map<string, number>();
    const toolCallSignatureHistory: Array<{
      signature: string;
      evidenceFingerprint: string;
    }> = [];
    const lastEvidenceFingerprintBySignature = new Map<string, string>();
    let noProgressTerminalNotified = false;
    let browserProofRequired = false;
    let browserProofSuccessCount = 0;

    const buildToolCallSignature = (toolCalls: ToolCallItem[]): string => {
      return toolCalls
        .map((tc) => {
          const canonical = String(
            orchestrator.resolveToolContract(tc.function.name)?.name ||
              tc.function.name,
          )
            .trim()
            .toLowerCase();
          return `${canonical}:${normalizeToolArgsForSignature(tc.function.arguments || "")}`;
        })
        .join("||");
    };

    const isToolCallRequiringBrowserProof = (
      toolCall: ToolCallItem,
      canonicalToolName: string,
    ): boolean => {
      if (!BROWSER_PROOF_REQUIRED_TOOL_NAMES.has(canonicalToolName)) {
        return false;
      }
      if (canonicalToolName !== "computer") return true;
      const args = parseToolCallArgs(toolCall.function.arguments || "");
      const action = String(args?.action || "")
        .trim()
        .toLowerCase();
      if (!action) return false;
      return !["wait", "hover", "scroll", "scroll_to"].includes(action);
    };

    const didToolProvideBrowserProof = (
      toolName: string,
      responsePayload: JsonRecord,
    ): boolean => {
      const normalized = String(toolName || "")
        .trim()
        .toLowerCase();
      const directVerified =
        responsePayload.verified === true ||
        String(responsePayload.verifyReason || "") === "verified";
      if (directVerified) return true;
      if (normalized === "browser_verify") {
        return toRecord(responsePayload.data).ok === true;
      }
      const nestedVerify = toRecord(toRecord(responsePayload.data).verify);
      return nestedVerify.ok === true;
    };

    const buildNoProgressScopeKey = (
      reason: NoProgressReason,
      scopeKey: string,
    ): string => `${reason}:${scopeKey || "(default)"}`;

    const clearNoProgressHits = (...reasons: NoProgressReason[]): void => {
      if (reasons.length <= 0) {
        noProgressHits.clear();
        return;
      }
      for (const key of Array.from(noProgressHits.keys())) {
        if (reasons.some((reason) => key.startsWith(`${reason}:`))) {
          noProgressHits.delete(key);
        }
      }
    };

    const resolveNoProgressDecision = (
      reason: NoProgressReason,
      scopeKey: string,
    ): {
      hit: number;
      continueBudget: number;
      remainingContinueBudget: number;
      decision: "continue" | "stop";
    } => {
      const bucketKey = buildNoProgressScopeKey(reason, scopeKey);
      const hit = (noProgressHits.get(bucketKey) || 0) + 1;
      noProgressHits.set(bucketKey, hit);
      const continueBudget = NO_PROGRESS_CONTINUE_BUDGET[reason] ?? 0;
      const remainingContinueBudget = Math.max(0, continueBudget - hit);
      const decision: "continue" | "stop" =
        hit <= continueBudget ? "continue" : "stop";
      return {
        hit,
        continueBudget,
        remainingContinueBudget,
        decision,
      };
    };

    const onNoProgressSignal = async (
      reason: NoProgressReason,
      details: JsonRecord,
      options: { emitBrowserGuard?: boolean; scopeKey?: string } = {},
    ): Promise<boolean> => {
      const scopeKey =
        String(options.scopeKey || details.signature || details.reasonDetail || "default").trim() ||
        "default";
      const decision = resolveNoProgressDecision(reason, scopeKey);
      const payload: JsonRecord = {
        reason,
        scopeKey,
        decision: decision.decision,
        hit: decision.hit,
        budget: {
          retry: decision.continueBudget,
          continue: decision.continueBudget,
          remainingRetry: decision.remainingContinueBudget,
          remainingContinue: decision.remainingContinueBudget,
        },
        ...details,
      };
      orchestrator.events.emit("loop_no_progress", sessionId, payload);
      if (options.emitBrowserGuard === true) {
        orchestrator.events.emit(
          "loop_guard_browser_progress_missing",
          sessionId,
          payload,
        );
      }
      if (decision.decision === "stop") {
        finalStatus = "progress_uncertain";
        if (!noProgressTerminalNotified) {
          noProgressTerminalNotified = true;
          await orchestrator.sessions.appendMessage({
            sessionId,
            role: "assistant",
            text: "连续多轮缺乏有效推进，已停止当前执行以避免无效循环。",
          });
        }
        return true;
      }
      return false;
    };

    try {
      await orchestrator.preSendCompactionCheck(sessionId);
      const context =
        await orchestrator.sessions.buildSessionContext(sessionId);
      const meta = await orchestrator.sessions.getMeta(sessionId);
      let availableSkillsPrompt = "";
      try {
        const skills = await orchestrator.listSkills();
        availableSkillsPrompt = buildAvailableSkillsSystemMessage(skills);
      } catch {
        availableSkillsPrompt = "";
      }
      const actionFailures = getActionFailures(sessionId);
      const llmToolDefinitions = listRuntimeLlmToolDefinitions("all");
      const systemPrompt = await buildResolvedSystemPrompt({
        config,
        sessionId,
        sessionMeta: meta,
        toolDefinitions: llmToolDefinitions,
      });
      const messages = applyLatestUserPromptOverride(
        await buildLlmMessagesFromContext(
          systemPrompt,
          meta,
          context.messages,
          availableSkillsPrompt,
          {
            sessionId,
            filesystemInspect,
            actionFailures,
          },
        ),
        prompt,
      );

      while (llmStep < maxLoopSteps) {
        let state = orchestrator.getRunState(sessionId);
        if (state.stopped) {
          finalStatus = "stopped";
          break;
        }
        while (state.paused && !state.stopped) {
          await delay(120);
          state = orchestrator.getRunState(sessionId);
        }
        if (state.stopped) {
          finalStatus = "stopped";
          break;
        }

        const dequeuedSteers = orchestrator.dequeueQueuedPrompts(
          sessionId,
          "steer",
        );
        for (const steer of dequeuedSteers) {
          const steerRawText = String(steer.text || "").trim();
          const steerSkillIds = normalizeExplicitSkillIds(steer.skillIds);
          const steerContextRefs = normalizeExplicitContextRefs(steer.contextRefs);
          if (
            !steerRawText &&
            steerSkillIds.length === 0 &&
            steerContextRefs.length === 0
          ) continue;
          const sessionMeta = await orchestrator.sessions.getMeta(sessionId);
          const steerPromptPayload = await buildPromptExecutionPayload({
            sessionId,
            sessionMeta,
            rawPrompt: steerRawText,
            skillIds: steerSkillIds,
            contextRefs: steerContextRefs,
          });
          const steerStoredText =
            steerPromptPayload.storedText ||
            steerRawText ||
            formatSkillSelectionSummary(steerSkillIds) ||
            formatPromptContextRefSummary(steerContextRefs) ||
            "附带上下文引用";
          await orchestrator.appendUserMessage(sessionId, steerStoredText, {
            metadata: steerPromptPayload.metadata,
          });
          await orchestrator.preSendCompactionCheck(sessionId);
          messages.push({
            role: "user",
            content: steerPromptPayload.llmText,
          });
          const runtimeAfterDequeue = orchestrator.getRunState(sessionId);
          orchestrator.events.emit("message.dequeued", sessionId, {
            behavior: "steer",
            id: steer.id,
            text: clipText(steerStoredText, 3000),
            contextRefCount: steerPromptPayload.contextRefCount,
            total: runtimeAfterDequeue.queue.total,
            steer: runtimeAfterDequeue.queue.steer,
            followUp: runtimeAfterDequeue.queue.followUp,
          });
          orchestrator.events.emit("input.steer", sessionId, {
            text: clipText(steerStoredText, 3000),
            id: steer.id,
            contextRefCount: steerPromptPayload.contextRefCount,
          });
        }

        llmStep += 1;
        const requestMessages = [
          ...messages,
          {
            role: "system",
            content: buildTaskProgressSystemMessage({
              llmStep,
              maxLoopSteps,
              toolStep,
              retryAttempt: Number(state.retry.attempt || 0),
              retryMaxAttempts: Number(
                state.retry.maxAttempts || activeRoute.llmRetryMaxAttempts,
              ),
            }),
          },
        ];
        let message: JsonRecord;
        try {
          message = await requestLlmWithRetry({
            sessionId,
            route: activeRoute,
            providerRegistry: llmProviders,
            step: llmStep,
            messages: requestMessages,
            toolChoice: "auto",
            toolScope: "all",
          });
          llmFailureBySignature.clear();
        } catch (error) {
          const signature = buildLlmFailureSignature(error);
          const signatureHits = (llmFailureBySignature.get(signature) || 0) + 1;
          llmFailureBySignature.set(signature, signatureHits);
          const runtimeError = asRuntimeErrorWithMeta(error);
          const details = toRecord(runtimeError.details);
          const retryAttempts = Number(details.retryAttempts || 0);
          const repeatedFailure = retryAttempts > 1 || signatureHits > 1;
          if (repeatedFailure) {
            const decision = decideProfileEscalation({
              orderedProfiles: activeRoute.orderedProfiles,
              currentProfile: activeRoute.profile,
              repeatedFailure: true,
              policy: activeRoute.escalationPolicy,
            });
            if (decision.type === "escalate") {
              const nextResolved = resolveLlmRoute({
                config,
                profile: decision.nextProfile,
                role: activeRoute.role,
                escalationPolicy: activeRoute.escalationPolicy,
              });
              if (
                nextResolved.ok &&
                llmProviders.has(nextResolved.route.provider)
              ) {
                const fromRoute = activeRoute;
                activeRoute = nextResolved.route;
                llmFailureBySignature.clear();
                orchestrator.updateRetryState(sessionId, {
                  active: false,
                  attempt: 0,
                  delayMs: 0,
                  maxAttempts: activeRoute.llmRetryMaxAttempts,
                });
                orchestrator.events.emit("llm.route.escalated", sessionId, {
                  signature,
                  signatureHits,
                  retryAttempts,
                  reason: decision.reason,
                  fromProfile: fromRoute.profile,
                  toProfile: activeRoute.profile,
                  fromProvider: fromRoute.provider,
                  toProvider: activeRoute.provider,
                  fromModel: fromRoute.llmModel,
                  toModel: activeRoute.llmModel,
                });
                orchestrator.events.emit(
                  "llm.route.selected",
                  sessionId,
                  buildLlmRoutePayload(activeRoute, {
                    source: "escalation",
                    reason: decision.reason,
                    signature,
                  }),
                );
                const latestMeta =
                  await orchestrator.sessions.getMeta(sessionId);
                if (latestMeta) {
                  try {
                    await writeSessionMeta(
                      sessionId,
                      withSessionLlmRouteMeta(latestMeta, activeRoute),
                    );
                  } catch {
                    // ignore metadata write failures
                  }
                }
                continue;
              }
              orchestrator.events.emit("llm.route.blocked", sessionId, {
                reason: "provider_not_found",
                signature,
                requestedProfile: decision.nextProfile,
                ...buildLlmRoutePayload(activeRoute),
              });
              const blockedMessage = `执行失败：升级到 profile ${decision.nextProfile} 时未找到可用 provider。`;
              await orchestrator.sessions.appendMessage({
                sessionId,
                role: "assistant",
                text: blockedMessage,
              });
              finalStatus = "failed_execute";
              throw new Error(blockedMessage);
            }
            if (decision.type === "blocked") {
              orchestrator.events.emit("llm.route.blocked", sessionId, {
                reason: decision.reason,
                signature,
                signatureHits,
                retryAttempts,
                ...buildLlmRoutePayload(activeRoute),
              });
              const blockedMessage =
                decision.reason === "no_higher_profile"
                  ? "执行失败：已达到当前角色可升级的最高 profile，无法继续自动升级。"
                  : `执行失败：当前 profile 未被升级链识别（${activeRoute.profile}）。`;
              await orchestrator.sessions.appendMessage({
                sessionId,
                role: "assistant",
                text: blockedMessage,
              });
              finalStatus = "failed_execute";
              throw new Error(blockedMessage);
            }
          }
          throw error;
        }

        const assistantText = parseLlmContent(message).trim();
        const toolCalls = normalizeToolCalls(message.tool_calls);
        orchestrator.events.emit("llm.response.parsed", sessionId, {
          step: llmStep,
          toolCalls: toolCalls.length,
          hasText: !!assistantText,
          source:
            resolveRouteRuntimeKind(activeRoute) === "hosted_chat"
              ? "hosted_chat_transport"
              : "llm_provider",
        });

        messages.push({
          role: "assistant",
          content: buildAssistantContentBlocks(assistantText, toolCalls),
        });

        if (toolCalls.length === 0) {
          if (browserProofRequired && browserProofSuccessCount === 0) {
            const shouldStop = await onNoProgressSignal(
              "browser_proof_guard",
              {
                step: llmStep,
                reasonDetail: "final_answer_without_browser_proof",
              },
              {
                emitBrowserGuard: true,
                scopeKey: "final_answer_without_browser_proof",
              },
            );
            if (shouldStop) {
              break;
            }
            continue;
          }
          // 仅在最终回答阶段（无工具调用）写入 assistant 文本。
          // 含 tool_calls 的中间思考阶段只通过流式态和工具步骤卡展示，避免正文被切碎成多段。
          await orchestrator.sessions.appendMessage({
            sessionId,
            role: "assistant",
            text: assistantText || "LLM 返回空内容。",
          });
          orchestrator.events.emit("step_finished", sessionId, {
            step: llmStep,
            ok: true,
            mode: "llm",
            preview: clipText(assistantText, 1200),
          });
          break;
        }

        const toolCallSignature = buildToolCallSignature(toolCalls);
        const previousEvidenceFingerprint = toolCallSignature
          ? lastEvidenceFingerprintBySignature.get(toolCallSignature) || ""
          : "";
        let stepUsedBrowserProofRequiredTool = false;
        let stepObservedBrowserProof = false;
        const stepEvidenceParts: string[] = [];
        let skipRemainingToolCallsBySteer = false;
        for (
          let toolCallIndex = 0;
          toolCallIndex < toolCalls.length;
          toolCallIndex += 1
        ) {
          if (orchestrator.getRunState(sessionId).stopped) {
            finalStatus = "stopped";
            break;
          }
          const tc = toolCalls[toolCallIndex];
          if (orchestrator.hasQueuedPrompt(sessionId, "steer")) {
            const skippedCount = toolCalls.length - toolCallIndex;
            skipRemainingToolCallsBySteer = true;
            orchestrator.events.emit("tool.skipped_due_to_steer", sessionId, {
              beforeTool: tc.function.name,
              beforeToolCallId: tc.id,
              skippedCount,
            });
            break;
          }
          const canonicalToolName = String(
            orchestrator.resolveToolContract(tc.function.name)?.name ||
              tc.function.name,
          )
            .trim()
            .toLowerCase();
          if (isToolCallRequiringBrowserProof(tc, canonicalToolName)) {
            browserProofRequired = true;
            stepUsedBrowserProofRequiredTool = true;
          }
          toolStep += 1;
          orchestrator.events.emit("step_planned", sessionId, {
            step: toolStep,
            mode: "tool_call",
            action: tc.function.name,
            arguments: clipText(tc.function.arguments, 500),
          });

          let result = await executeToolCall(sessionId, tc);
          if (result.error) {
            const modeEscalation = toRecord(result.modeEscalation);
            const focusEscalationKey = `${String(tc.id || "")}|${String(
              tc.function.name || "",
            )
              .trim()
              .toLowerCase()}`;
            const canAutoEscalateToFocus =
              [
                "click",
                "fill_element_by_uid",
                "select_option_by_uid",
                "hover_element_by_uid",
                "press_key",
                "scroll_page",
                "navigate_tab",
                "scroll_to_element",
                "highlight_element",
                "highlight_text_inline",
                "fill_form",
              ].includes(canonicalToolName) &&
              result.retryable === true &&
              normalizeFailureReason(result.errorReason) === "failed_execute" &&
              modeEscalation.suggested === true &&
              String(modeEscalation.to || "")
                .trim()
                .toLowerCase() === "focus" &&
              !focusEscalationReplayKeys.has(focusEscalationKey);
            if (canAutoEscalateToFocus) {
              const escalatedToolCall = buildFocusEscalationToolCall(tc);
              if (escalatedToolCall) {
                focusEscalationReplayKeys.add(focusEscalationKey);
                orchestrator.events.emit("tool.mode_escalation", sessionId, {
                  step: toolStep,
                  tool: tc.function.name,
                  toolCallId: tc.id,
                  from: String(modeEscalation.from || "background"),
                  to: "focus",
                  status: "retrying",
                });
                const escalatedResult = await executeToolCall(
                  sessionId,
                  escalatedToolCall,
                );
                if (!escalatedResult.error) {
                  const escalatedResponse = toRecord(escalatedResult.response);
                  const escalatedData = escalatedResponse.data;
                  if (
                    escalatedData &&
                    typeof escalatedData === "object" &&
                    !Array.isArray(escalatedData)
                  ) {
                    escalatedResponse.data = {
                      ...(escalatedData as JsonRecord),
                      modeEscalated: true,
                      modeEscalation: {
                        from: String(modeEscalation.from || "background"),
                        to: "focus",
                        auto: true,
                      },
                    };
                  }
                  result = {
                    ...escalatedResult,
                    response: escalatedResponse,
                  };
                  orchestrator.events.emit("tool.mode_escalation", sessionId, {
                    step: toolStep,
                    tool: tc.function.name,
                    toolCallId: tc.id,
                    from: String(modeEscalation.from || "background"),
                    to: "focus",
                    status: "recovered",
                  });
                } else {
                  result = escalatedResult;
                  orchestrator.events.emit("tool.mode_escalation", sessionId, {
                    step: toolStep,
                    tool: tc.function.name,
                    toolCallId: tc.id,
                    from: String(modeEscalation.from || "background"),
                    to: "focus",
                    status: "failed",
                    error: String(escalatedResult.error || "unknown"),
                  });
                }
              }
            }
          }

          if (result.error) {
            const errorCode = normalizeErrorCode(result.errorCode);
            const interruptedBySteer =
              errorCode === "E_BRIDGE_INTERRUPTED" &&
              orchestrator.hasQueuedPrompt(sessionId, "steer");
            if (interruptedBySteer) {
              const skippedCount = toolCalls.length - toolCallIndex - 1;
              orchestrator.events.emit("tool.interrupted_by_steer", sessionId, {
                step: toolStep,
                action: tc.function.name,
                toolCallId: tc.id,
                skippedCount,
              });
              orchestrator.events.emit("step_finished", sessionId, {
                step: toolStep,
                ok: false,
                mode: "tool_call",
                action: tc.function.name,
                error: "interrupted_by_steer",
                modeUsed: String(result.modeUsed || ""),
                providerId: String(result.providerId || ""),
                fallbackFrom: String(result.fallbackFrom || ""),
              });
              skipRemainingToolCallsBySteer = true;
              break;
            }
            const failurePayload = buildToolFailurePayload(tc, result);
            stepEvidenceParts.push(buildNoProgressEvidenceFingerprint(failurePayload));
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: safeStringify(failurePayload, 6000),
            });
            await orchestrator.sessions.appendMessage({
              sessionId,
              role: "tool",
              text: safeStringify(failurePayload, 10_000),
              toolName: tc.function.name,
              toolCallId: tc.id,
            });
            orchestrator.events.emit("step_finished", sessionId, {
              step: toolStep,
              ok: false,
              mode: "tool_call",
              action: tc.function.name,
              error: String(result.error),
              modeUsed: String(result.modeUsed || ""),
              providerId: String(result.providerId || ""),
              fallbackFrom: String(result.fallbackFrom || ""),
            });
            // PI 对齐：工具失败写入 tool_result 后继续当前 loop，由后续 LLM 结合失败结果重规划。
            continue;
          }

          const responsePayload = toRecord(result.response);
          if (didToolProvideBrowserProof(canonicalToolName, responsePayload)) {
            stepObservedBrowserProof = true;
            browserProofSuccessCount += 1;
          }
          const rawToolData = responsePayload.data ?? result;
          const llmToolContent = safeStringify(rawToolData, 12_000);
          const uiToolPayload = buildToolSuccessPayload(tc, rawToolData, {
            modeUsed: result.modeUsed,
            providerId: result.providerId,
            fallbackFrom: result.fallbackFrom,
          });
          stepEvidenceParts.push(buildNoProgressEvidenceFingerprint(uiToolPayload));
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: llmToolContent,
          });
          await orchestrator.sessions.appendMessage({
            sessionId,
            role: "tool",
            text: clipText(safeStringify(uiToolPayload, 10_000), 10_000),
            toolName: tc.function.name,
            toolCallId: tc.id,
          });
          orchestrator.events.emit("step_finished", sessionId, {
            step: toolStep,
            ok: true,
            mode: "tool_call",
            action: tc.function.name,
            preview: clipText(llmToolContent, 800),
            modeUsed: String(result.modeUsed || ""),
            providerId: String(result.providerId || ""),
            fallbackFrom: String(result.fallbackFrom || ""),
          });

          if (
            toolCallIndex < toolCalls.length - 1 &&
            orchestrator.hasQueuedPrompt(sessionId, "steer")
          ) {
            const skippedCount = toolCalls.length - toolCallIndex - 1;
            skipRemainingToolCallsBySteer = true;
            orchestrator.events.emit("tool.skipped_due_to_steer", sessionId, {
              afterTool: tc.function.name,
              afterToolCallId: tc.id,
              skippedCount,
            });
            break;
          }
        }

        if (finalStatus === "stopped" || finalStatus === "progress_uncertain") {
          break;
        }
        if (skipRemainingToolCallsBySteer) {
          continue;
        }

        const stepEvidenceFingerprint = buildNoProgressEvidenceFingerprint(
          stepEvidenceParts,
        );
        const stepFreshEvidence =
          !!toolCallSignature &&
          !!previousEvidenceFingerprint &&
          stepEvidenceFingerprint !== previousEvidenceFingerprint;
        const stepRepeatedWithoutNewEvidence =
          !!toolCallSignature &&
          !!previousEvidenceFingerprint &&
          stepEvidenceFingerprint === previousEvidenceFingerprint;

        if (toolCallSignature) {
          lastEvidenceFingerprintBySignature.set(
            toolCallSignature,
            stepEvidenceFingerprint,
          );
        }

        if (stepObservedBrowserProof) {
          toolCallSignatureHistory.length = 0;
          clearNoProgressHits(
            "repeat_signature",
            "ping_pong",
            "browser_proof_guard",
          );
        } else if (stepFreshEvidence) {
          clearNoProgressHits("repeat_signature", "browser_proof_guard");
        }

        let browserGuardSignaled = false;
        if (
          stepUsedBrowserProofRequiredTool &&
          !stepObservedBrowserProof &&
          !stepFreshEvidence
        ) {
          browserGuardSignaled = true;
          const shouldStop = await onNoProgressSignal(
            "browser_proof_guard",
            {
              step: llmStep,
              toolStep,
              signature: toolCallSignature,
              evidenceHash: stableHash(stepEvidenceFingerprint),
              evidenceFresh: false,
            },
            {
              emitBrowserGuard: true,
              scopeKey:
                toolCallSignature ||
                `step:${llmStep}:tool:${toolStep}:browser_proof_guard`,
            },
          );
          if (shouldStop) {
            break;
          }
        }

        if (!browserGuardSignaled && toolCallSignature) {
          toolCallSignatureHistory.push({
            signature: toolCallSignature,
            evidenceFingerprint: stepEvidenceFingerprint,
          });
          while (
            toolCallSignatureHistory.length >
            NO_PROGRESS_SIGNATURE_HISTORY_LIMIT
          ) {
            toolCallSignatureHistory.shift();
          }

          let reason: NoProgressReason | null = null;
          const len = toolCallSignatureHistory.length;
          const detail: JsonRecord = {
            step: llmStep,
            toolStep,
            signature: toolCallSignature,
          };

          if (len >= 4) {
            const a = toolCallSignatureHistory[len - 4];
            const b = toolCallSignatureHistory[len - 3];
            const c = toolCallSignatureHistory[len - 2];
            const d = toolCallSignatureHistory[len - 1];
            if (
              a.signature === c.signature &&
              b.signature === d.signature &&
              a.signature !== b.signature &&
              a.evidenceFingerprint === c.evidenceFingerprint &&
              b.evidenceFingerprint === d.evidenceFingerprint
            ) {
              reason = "ping_pong";
              detail.sequence = [
                a.signature,
                b.signature,
                c.signature,
                d.signature,
              ];
              detail.sequenceEvidenceHash = [
                stableHash(a.evidenceFingerprint),
                stableHash(b.evidenceFingerprint),
                stableHash(c.evidenceFingerprint),
                stableHash(d.evidenceFingerprint),
              ];
            }
          }

          if (!reason && len >= 2) {
            const prev = toolCallSignatureHistory[len - 2];
            const curr = toolCallSignatureHistory[len - 1];
            if (
              prev.signature === curr.signature &&
              prev.evidenceFingerprint === curr.evidenceFingerprint &&
              stepRepeatedWithoutNewEvidence
            ) {
              reason = "repeat_signature";
              detail.previousSignature = prev.signature;
              detail.evidenceHash = stableHash(curr.evidenceFingerprint);
            }
          }

          if (reason) {
            const shouldStop = await onNoProgressSignal(reason, detail, {
              scopeKey:
                reason === "ping_pong" && Array.isArray(detail.sequence)
                  ? (detail.sequence as string[]).slice(0, 2).join("=>")
                  : toolCallSignature,
            });
            if (shouldStop) {
              break;
            }
          }
        }
      }

      if (llmStep >= maxLoopSteps && finalStatus === "done") {
        finalStatus = "max_steps";
        await orchestrator.sessions.appendMessage({
          sessionId,
          role: "assistant",
          text: `已达到最大步数 ${maxLoopSteps}，结束本轮执行。`,
        });
      }
    } catch (error) {
      const runtimeError = asRuntimeErrorWithMeta(error);
      const message = runtimeError.message || String(error);
      const errorCode = normalizeErrorCode(runtimeError.code);
      const stoppedByUser =
        orchestrator.getRunState(sessionId).stopped ||
        errorCode === "E_BRIDGE_ABORTED";
      if (stoppedByUser) {
        finalStatus = "stopped";
      } else {
        if (!String(message || "").includes("工具")) {
          await orchestrator.sessions.appendMessage({
            sessionId,
            role: "assistant",
            text: `执行失败：${message}`,
          });
          if (finalStatus === "done") {
            finalStatus = "failed_execute";
          }
        }
        orchestrator.events.emit("loop_error", sessionId, {
          message,
        });
      }
    } finally {
      try {
        await refreshSessionTitleAuto(
          orchestrator,
          sessionId,
          infra,
          llmProviders,
        );
      } catch (titleError) {
        orchestrator.events.emit(
          "session_title_auto_update_failed",
          sessionId,
          {
            error:
              titleError instanceof Error
                ? titleError.message
                : String(titleError),
          },
        );
      }
      orchestrator.setRunning(sessionId, false);
      orchestrator.events.emit("loop_done", sessionId, {
        status: finalStatus,
        llmSteps: llmStep,
        toolSteps: toolStep,
      });
      const runtimeAfterDone = orchestrator.getRunState(sessionId);
      if (!runtimeAfterDone.stopped && runtimeAfterDone.queue.steer > 0) {
        const steers = orchestrator.dequeueQueuedPrompts(sessionId, "steer");
        const nextSteer = steers[0];
        if (nextSteer) {
          const runtimeAfterDequeue = orchestrator.getRunState(sessionId);
          orchestrator.events.emit("message.dequeued", sessionId, {
            behavior: "steer",
            id: nextSteer.id,
            text: clipText(nextSteer.text, 3000),
            total: runtimeAfterDequeue.queue.total,
            steer: runtimeAfterDequeue.queue.steer,
            followUp: runtimeAfterDequeue.queue.followUp,
          });
          orchestrator.events.emit("input.steer", sessionId, {
            text: clipText(nextSteer.text, 3000),
            id: nextSteer.id,
          });
          void startFromPrompt({
            sessionId,
            prompt: nextSteer.text,
            skillIds: nextSteer.skillIds,
            contextRefs: nextSteer.contextRefs,
            autoRun: true,
          }).catch((error) => {
            orchestrator.events.emit("loop_internal_error", sessionId, {
              error: error instanceof Error ? error.message : String(error),
              reason: "steer_start_failed",
            });
          });
          return;
        }
      }
      if (!runtimeAfterDone.stopped && runtimeAfterDone.queue.followUp > 0) {
        const followUps = orchestrator.dequeueQueuedPrompts(
          sessionId,
          "followUp",
        );
        const nextFollowUp = followUps[0];
        if (nextFollowUp) {
          const runtimeAfterDequeue = orchestrator.getRunState(sessionId);
          orchestrator.events.emit("message.dequeued", sessionId, {
            behavior: "followUp",
            id: nextFollowUp.id,
            text: clipText(nextFollowUp.text, 3000),
            total: runtimeAfterDequeue.queue.total,
            steer: runtimeAfterDequeue.queue.steer,
            followUp: runtimeAfterDequeue.queue.followUp,
          });
          orchestrator.events.emit("loop_follow_up_start", sessionId, {
            id: nextFollowUp.id,
            text: clipText(nextFollowUp.text, 3000),
          });
          void startFromPrompt({
            sessionId,
            prompt: nextFollowUp.text,
            skillIds: nextFollowUp.skillIds,
            contextRefs: nextFollowUp.contextRefs,
            autoRun: true,
          }).catch((error) => {
            orchestrator.events.emit("loop_internal_error", sessionId, {
              error: error instanceof Error ? error.message : String(error),
              reason: "follow_up_start_failed",
            });
          });
        }
      }
    }
  }

  async function applySharedTabs(
    sessionId: string,
    tabIdsInput: unknown[],
  ): Promise<void> {
    const tabIds = normalizeTabIds(tabIdsInput);
    const allTabs = await queryAllTabsForRuntime();
    const byId = new Map(allTabs.map((tab) => [Number(tab.id), tab]));
    const sharedTabs = tabIds
      .map((id) => byId.get(id))
      .filter(
        (
          tab,
        ): tab is {
          id: number;
          windowId: number;
          index: number;
          active: boolean;
          pinned: boolean;
          title: string;
          url: string;
        } => Boolean(tab),
      )
      .map((tab) => ({
        id: Number(tab.id),
        title: String(tab.title || ""),
        url: String(tab.url || ""),
      }));

    const meta = await orchestrator.sessions.getMeta(sessionId);
    if (meta) {
      const header = toRecord(meta.header);
      const metadata = toRecord(header.metadata);
      if (sharedTabs.length > 0) {
        metadata.sharedTabs = sharedTabs;
        const currentPrimary = parsePositiveInt(metadata.primaryTabId);
        const sharedTabIds = sharedTabs
          .map((tab) => Number(tab.id))
          .filter((id) => Number.isInteger(id) && id > 0);
        metadata.primaryTabId =
          currentPrimary && sharedTabIds.includes(currentPrimary)
            ? currentPrimary
            : Number(sharedTabs[0].id);
      } else {
        delete metadata.sharedTabs;
        delete metadata.primaryTabId;
      }
      await writeSessionMeta(sessionId, {
        ...meta,
        header: {
          ...meta.header,
          metadata,
        },
      });
    }

    orchestrator.events.emit("input.shared_tabs", sessionId, {
      providedTabIds: tabIds,
      resolvedCount: sharedTabs.length,
      primaryTabId: sharedTabs.length > 0 ? Number(sharedTabs[0].id) : null,
    });
  }

  function parseSkillSlashPrompt(
    prompt: string,
  ): { skillId: string; argsText: string } | null {
    const text = String(prompt || "").trim();
    if (!text.startsWith("/skill:")) return null;
    const rest = text.slice("/skill:".length).trim();
    if (!rest) {
      throw new Error("skill 命令格式错误：请使用 /skill:<skillId> [args]");
    }
    const firstSpace = rest.search(/\s/);
    if (firstSpace < 0) {
      return {
        skillId: rest,
        argsText: "",
      };
    }
    return {
      skillId: rest.slice(0, firstSpace).trim(),
      argsText: rest.slice(firstSpace + 1).trim(),
    };
  }

  function normalizeExplicitSkillIds(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of input) {
      const skillId = String(item || "").trim();
      if (!skillId || seen.has(skillId)) continue;
      seen.add(skillId);
      out.push(skillId);
      if (out.length >= MAX_PROMPT_SKILL_ITEMS) break;
    }
    return out;
  }

  function formatSkillSelectionSummary(skillIds: string[]): string {
    if (!skillIds.length) return "";
    return skillIds.map((id) => `[skill:${id}]`).join(" ");
  }

  function normalizeExplicitContextRefs(input: unknown): PromptContextRefInput[] {
    return dedupePromptContextRefs(
      normalizePromptContextRefs(input).filter(
        (item) => item.source !== "prompt_parser",
      ),
    );
  }

  function buildSkillCommandPrompt(input: {
    promptBlock: string;
    argsText: string;
    skillId: string;
    skillName: string;
  }): string {
    const parts = [
      "以下是通过 /skill 显式选择的技能，请先阅读并严格按技能流程执行：",
      input.promptBlock,
    ];
    if (input.argsText) {
      parts.push(`<skill_args>\n${input.argsText}\n</skill_args>`);
    }
    parts.push(
      `说明：你当前执行的技能是 ${input.skillName}（id=${input.skillId}）。`,
    );
    return parts.join("\n\n");
  }

  async function expandExplicitSelectedSkillsPrompt(
    sessionId: string,
    prompt: string,
    skillIds: string[],
  ): Promise<string> {
    const normalizedPrompt = String(prompt || "").trim();
    if (!skillIds.length) return normalizedPrompt;

    const promptBlocks: string[] = [];
    const selectedLabels: string[] = [];
    for (const skillId of skillIds) {
      const resolved = await orchestrator.resolveSkillContent(skillId, {
        sessionId,
        capability: CAPABILITIES.fsRead,
      });
      promptBlocks.push(resolved.promptBlock);
      selectedLabels.push(`${resolved.skill.name}（id=${resolved.skill.id}）`);
    }

    const parts = [
      "以下是用户在输入框中显式选择的技能，请先阅读并按技能流程执行：",
      ...promptBlocks,
    ];
    if (normalizedPrompt) {
      parts.push(`<skill_args>\n${normalizedPrompt}\n</skill_args>`);
    } else {
      parts.push("说明：用户未提供额外文本，请按所选技能流程完成任务。");
    }
    parts.push(`说明：本次显式选择技能：${selectedLabels.join("，")}。`);
    return parts.join("\n\n");
  }

  async function expandSkillSlashPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<string> {
    const parsed = parseSkillSlashPrompt(prompt);
    if (!parsed) return String(prompt || "");
    const resolved = await orchestrator.resolveSkillContent(parsed.skillId, {
      sessionId,
      capability: CAPABILITIES.fsRead,
    });
    return buildSkillCommandPrompt({
      promptBlock: resolved.promptBlock,
      argsText: parsed.argsText,
      skillId: resolved.skill.id,
      skillName: resolved.skill.name,
    });
  }

  async function buildPromptExecutionPayload(input: {
    sessionId: string;
    sessionMeta: SessionMeta | null;
    rawPrompt: string;
    skillIds: string[];
    contextRefs: PromptContextRefInput[];
  }): Promise<{
    storedText: string;
    llmText: string;
    metadata: Record<string, unknown> | undefined;
    contextRefCount: number;
  }> {
    const parsedRefs = extractPromptContextRefs(input.rawPrompt, "prompt_parser");
    const mergedRefs = dedupePromptContextRefs([
      ...input.contextRefs,
      ...parsedRefs.refs,
    ]);
    const resolvedRefs = await contextRefService.resolveContextRefs({
      sessionId: input.sessionId,
      sessionMeta: input.sessionMeta,
      refs: mergedRefs,
    });
    const failureMessage =
      contextRefService.buildContextRefFailureMessage(resolvedRefs);
    if (failureMessage) {
      throw new Error(failureMessage);
    }
    const materializedRefs = await contextRefService.materializeContextRefs({
      sessionId: input.sessionId,
      refs: resolvedRefs,
    });
    const promptWithRefPlaceholders = rewritePromptWithContextRefPlaceholders(
      input.rawPrompt,
      resolvedRefs,
    );
    const promptWithSelectedSkills = await expandExplicitSelectedSkillsPrompt(
      input.sessionId,
      promptWithRefPlaceholders,
      input.skillIds,
    );
    const promptForModel = await expandSkillSlashPrompt(
      input.sessionId,
      promptWithSelectedSkills,
    );
    const contextPrefix = contextRefService.buildContextPromptPrefix({
      refs: resolvedRefs,
      materialized: materializedRefs,
    });
    const llmPromptBody = String(promptForModel || "").trim();
    const llmText = contextPrefix
      ? [
          contextPrefix,
          `<user_prompt>\n${llmPromptBody || "请结合以上引用上下文继续当前任务。"}\n</user_prompt>`,
        ].join("\n\n")
      : llmPromptBody;
    const storedText =
      input.rawPrompt ||
      formatSkillSelectionSummary(input.skillIds) ||
      formatPromptContextRefSummary(mergedRefs) ||
      "";
    const metadata =
      contextPrefix || llmText !== storedText
        ? {
            llmText,
            contextRefs: contextRefService.toMetadataRows({
              refs: resolvedRefs,
              materialized: materializedRefs,
            }),
          }
        : undefined;
    return {
      storedText,
      llmText,
      metadata,
      contextRefCount: resolvedRefs.length,
    };
  }

  async function startLoopIfNeeded(
    sessionId: string,
    prompt: string,
    restartReason: string,
  ): Promise<RuntimeView> {
    const state = orchestrator.getRunState(sessionId);
    if (state.running) {
      orchestrator.events.emit("loop_enqueue_skipped", sessionId, {
        reason: state.stopped ? "stop_in_progress" : "already_running",
      });
      return orchestrator.getRunState(sessionId);
    }

    if (state.stopped) {
      orchestrator.restart(sessionId);
      orchestrator.events.emit("loop_restart", sessionId, {
        reason: restartReason,
      });
    }

    orchestrator.setRunning(sessionId, true);
    void runAgentLoop(sessionId, prompt).catch((error) => {
      orchestrator.events.emit("loop_internal_error", sessionId, {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return orchestrator.getRunState(sessionId);
  }

  async function startFromPrompt(
    input: RunStartInput,
  ): Promise<{ sessionId: string; runtime: RuntimeView }> {
    let sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
    if (!sessionId) {
      const created = await orchestrator.createSession(
        input.sessionOptions || {},
      );
      sessionId = created.sessionId;
    } else {
      const existed = await orchestrator.sessions.getMeta(sessionId);
      if (!existed) {
        await orchestrator.sessions.createSession({
          ...input.sessionOptions,
          id: sessionId,
        });
      }
    }

    const hasExplicitTabIds = Array.isArray(input.tabIds);
    if (hasExplicitTabIds) {
      await applySharedTabs(sessionId, normalizeTabIds(input.tabIds || []));
    } else {
      const inferredTabIds = extractTabIdsFromPrompt(
        String(input.prompt || ""),
      );
      if (inferredTabIds.length > 0) {
        await applySharedTabs(sessionId, inferredTabIds);
        orchestrator.events.emit("input.tab_ids_inferred", sessionId, {
          tabIds: inferredTabIds,
        });
      }
    }

    const rawPrompt = String(input.prompt || "").trim();
    const explicitSkillIds = normalizeExplicitSkillIds(input.skillIds);
    const explicitContextRefs = normalizeExplicitContextRefs(input.contextRefs);
    if (
      !rawPrompt &&
      explicitSkillIds.length === 0 &&
      explicitContextRefs.length === 0
    ) {
      return {
        sessionId,
        runtime: orchestrator.getRunState(sessionId),
      };
    }
    const sessionMeta = await orchestrator.sessions.getMeta(sessionId);
    const promptPayload = await buildPromptExecutionPayload({
      sessionId,
      sessionMeta,
      rawPrompt,
      skillIds: explicitSkillIds,
      contextRefs: explicitContextRefs,
    });
    const promptForModel = promptPayload.llmText;
    const storedPrompt =
      promptPayload.storedText ||
      rawPrompt ||
      formatSkillSelectionSummary(explicitSkillIds) ||
      formatPromptContextRefSummary(explicitContextRefs) ||
      "附带上下文引用";

    const behavior = normalizeStreamingBehavior(input.streamingBehavior);
    const state = orchestrator.getRunState(sessionId);
    if (state.running) {
      if (!behavior) {
        throw new Error(
          "会话正在运行中；请显式指定 streamingBehavior=steer|followUp",
        );
      }
      const queuedRuntime = orchestrator.enqueueQueuedPrompt(
        sessionId,
        behavior,
        rawPrompt,
        {
          skillIds: explicitSkillIds,
          contextRefs: explicitContextRefs,
        },
      );
      orchestrator.events.emit("message.queued", sessionId, {
        behavior,
        text: clipText(storedPrompt, 3000),
        contextRefCount: promptPayload.contextRefCount,
        total: queuedRuntime.queue.total,
        steer: queuedRuntime.queue.steer,
        followUp: queuedRuntime.queue.followUp,
      });
      if (behavior === "followUp") {
        orchestrator.events.emit("loop_follow_up_queued", sessionId, {
          text: clipText(storedPrompt, 3000),
          total: queuedRuntime.queue.followUp,
        });
      }
      return {
        sessionId,
        runtime: queuedRuntime,
      };
    }

    await orchestrator.appendUserMessage(sessionId, storedPrompt, {
      metadata: promptPayload.metadata,
    });
    orchestrator.events.emit("input.user", sessionId, {
      text: clipText(storedPrompt, 3000),
      contextRefCount: promptPayload.contextRefCount,
    });

    if (input.autoRun === false) {
      return {
        sessionId,
        runtime: orchestrator.getRunState(sessionId),
      };
    }

    return {
      sessionId,
      runtime: await startLoopIfNeeded(
        sessionId,
        promptForModel,
        "restart_after_stop",
      ),
    };
  }

  async function startFromRegenerate(
    input: RegenerateRunInput,
  ): Promise<{ sessionId: string; runtime: RuntimeView }> {
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) throw new Error("sessionId 不能为空");
    await orchestrator.sessions.ensureSession(sessionId);
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw new Error("regenerate prompt 不能为空");

    if (input.autoRun === false) {
      return {
        sessionId,
        runtime: orchestrator.getRunState(sessionId),
      };
    }

    return {
      sessionId,
      runtime: await startLoopIfNeeded(
        sessionId,
        prompt,
        "restart_after_regenerate",
      ),
    };
  }

  return {
    startFromPrompt,
    startFromRegenerate,
    executeStep,
    async refreshSessionTitle(
      sessionId: string,
      options: { force?: boolean } = {},
    ): Promise<string> {
      await refreshSessionTitleAuto(
        orchestrator,
        sessionId,
        infra,
        llmProviders,
        options,
      );
      const meta = await orchestrator.sessions.getMeta(sessionId);
      return normalizeSessionTitle(meta?.header.title, "");
    },
    async getSystemPromptPreview(): Promise<string> {
      const cfgRaw = await callInfra(infra, { type: "config.get" });
      const cfg = extractLlmConfig(cfgRaw);
      return await buildResolvedSystemPrompt({
        config: cfg,
        sessionId: "system-prompt-preview",
        sessionMeta: null,
        toolDefinitions: listRuntimeLlmToolDefinitions("all"),
      });
    },
  };
}
