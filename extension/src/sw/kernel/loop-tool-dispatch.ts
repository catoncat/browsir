/**
 * Tool dispatch: plan building, dispatching, and execution.
 * Extracted from runtime-loop.browser.ts to reduce file size.
 */
import type {
  BrainOrchestrator,
  ExecuteCapability,
  ExecuteMode,
  ExecuteStepResult,
  ToolContract,
} from "./orchestrator.browser";
import type { RuntimeInfraHandler } from "./runtime-infra.browser";
import type { CapabilityExecutionPolicy, StepVerifyPolicy } from "./capability-policy";
import type { SkillMetadata } from "./skill-registry";
import type { PromptContextRefInput } from "../../shared/context-ref";
import { isVirtualUri } from "./virtual-fs.browser";
import { normalizeSkillCreateRequest } from "./skill-create";
import {
  normalizeBrowserRuntimeStrategy,
  resolveBrowserRuntimeHint,
} from "./browser-runtime-strategy";
import {
  toRecord,
  clipText,
  safeStringify,
  normalizeIntInRange,
  parsePositiveInt,
  normalizeErrorCode,
  asRuntimeErrorWithMeta,
  delay,
  callInfra,
  attachFailureProtocol,
  extractBashExecOutcome,
  buildBashExitFailureEnvelope,
  buildSkillScriptSandboxFailureEnvelope,
  buildStepFailureEnvelope,
  inferSearchElementsFilter,
  normalizeVerifyExpect,
  scoreSearchNode,
  isRetryableToolErrorCode,
  shouldAutoReplayToolCall,
  computeToolRetryDelayMs,
  buildToolRetryHint,
  readContractExecution,
  sanitizeLlmToolDefinitionForProvider,
  normalizeToolArgsForSignature,
  normalizeSchemaRequiredList,
  readTopLevelConstraintRequiredSets,
  queryAllTabsForRuntime,
  getActiveTabIdForRuntime,
  extractLlmConfig,
  readSharedTabIds,
  CAPABILITIES,
  RUNTIME_EXECUTABLE_TOOL_NAMES,
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  type RuntimeErrorWithMeta,
  type ToolCallItem,
  type FailureReason,
} from "./runtime-loop.browser";
import { nowIso, type JsonRecord } from "./types";
import { writeSessionMeta } from "./session-store.browser";

// --- Constants moved from runtime-loop.browser.ts (dispatch-only) ---

export const MIN_BASH_TIMEOUT_MS = 200;
export const TOOL_AUTO_RETRY_MAX = 2;
export const BASH_RUNTIME_TOOL_NAMES = new Set(["host_bash", "browser_bash"]);

// --- Exported types ---

interface ResolvedToolCallContext {
  requestedTool: string;
  resolvedTool: string;
  executionTool: string;
  args: JsonRecord;
  customExecution?: {
    capability: ExecuteCapability;
    mode?: ExecuteMode;
    action?: string;
    verifyPolicy?: StepVerifyPolicy;
  };
}

type ToolPlan =
  | {
      kind: "bridge";
      toolName:
        | "host_bash"
        | "browser_bash"
        | "host_read_file"
        | "browser_read_file"
        | "host_write_file"
        | "browser_write_file"
        | "host_edit_file"
        | "browser_edit_file";
      capability: ExecuteCapability;
      frame: JsonRecord;
    }
  | {
      kind: "custom.invoke";
      toolName: string;
      capability: ExecuteCapability;
      mode?: ExecuteMode;
      action: string;
      args: JsonRecord;
      verifyPolicy?: StepVerifyPolicy;
    }
  | {
      kind: "local.get_all_tabs";
    }
  | {
      kind: "local.current_tab";
    }
  | {
      kind: "local.create_new_tab";
      args: JsonRecord;
    }
  | {
      kind: "local.get_tab_info";
      tabId: number;
    }
  | {
      kind: "local.close_tab";
      tabId: number | null;
    }
  | {
      kind: "local.ungroup_tabs";
      windowId: number | null;
    }
  | {
      kind: "local.list_interventions";
      enabledOnly: boolean;
    }
  | {
      kind: "local.get_intervention_info";
      interventionType: string;
    }
  | {
      kind: "local.request_intervention";
      sessionId: string;
      interventionType: string;
      params: JsonRecord;
      timeoutSec: number;
      reason: string;
    }
  | {
      kind: "local.cancel_intervention";
      sessionId: string;
      requestId: string;
    }
  | {
      kind: "local.list_skills";
      enabledOnly: boolean;
    }
  | {
      kind: "local.create_skill";
      sessionId: string;
      input: JsonRecord;
    }
  | {
      kind: "local.get_skill_info";
      skillName: string;
    }
  | {
      kind: "local.load_skill";
      sessionId: string;
      skillName: string;
    }
  | {
      kind: "local.read_skill_reference";
      sessionId: string;
      skillName: string;
      refPath: string;
    }
  | {
      kind: "local.get_skill_asset";
      sessionId: string;
      skillName: string;
      assetPath: string;
    }
  | {
      kind: "local.execute_skill_script";
      sessionId: string;
      skillName: string;
      scriptPath: string;
      scriptArgs: unknown;
    }
  | {
      kind: "step.search_elements";
      capability: ExecuteCapability;
      tabId: number;
      options: JsonRecord;
      query: string;
      maxResults: number;
    }
  | {
      kind: "step.element_action";
      toolName:
        | "click"
        | "fill_element_by_uid"
        | "select_option_by_uid"
        | "hover_element_by_uid"
        | "get_editor_value"
        | "press_key"
        | "scroll_page"
        | "navigate_tab"
        | "scroll_to_element";
      capability: ExecuteCapability;
      tabId: number;
      kindValue: string;
      action: JsonRecord;
      expect: unknown;
    }
  | {
      kind: "step.script_action";
      toolName:
        | "get_page_metadata"
        | "highlight_element"
        | "highlight_text_inline";
      capability: ExecuteCapability;
      tabId: number;
      expression: string;
      expect: JsonRecord | null;
    }
  | {
      kind: "step.capture_screenshot";
      toolName:
        | "capture_screenshot"
        | "capture_tab_screenshot"
        | "capture_screenshot_with_highlight";
      tabId: number;
      format: "png" | "jpeg";
      quality: number | null;
      selector: string;
      sendToLLM: boolean;
    }
  | {
      kind: "step.download_image";
      tabId: number;
      imageData: string;
      filename: string;
    }
  | {
      kind: "step.download_chat_images";
      tabId: number;
      files: Array<{
        imageData: string;
        filename: string;
      }>;
    }
  | {
      kind: "step.computer";
      tabId: number;
      action: string;
      coordinate: [number, number] | null;
      startCoordinate: [number, number] | null;
      text: string;
      scrollDirection: string;
      scrollAmount: number | null;
      durationSec: number | null;
      uid: string;
      selector: string;
    }
  | {
      kind: "step.fill_form";
      capability: ExecuteCapability;
      tabId: number;
      elements: Array<{
        uid: string;
        ref: string;
        selector: string;
        backendNodeId: number | null;
        value: string;
      }>;
      submit: JsonRecord | null;
      expect: JsonRecord;
    }
  | {
      kind: "step.browser_verify";
      capability: ExecuteCapability;
      tabId: number;
      verifyExpect: JsonRecord;
    };


// --- Shared helpers (used by both runtime-loop and this module) ---

export function createRuntimeError(
  message: string,
  meta: { code?: string; retryable?: boolean; details?: unknown } = {},
): RuntimeErrorWithMeta {
  const error = new Error(message) as RuntimeErrorWithMeta;
  if (meta.code) error.code = meta.code;
  if (typeof meta.retryable === "boolean") error.retryable = meta.retryable;
  if (meta.details !== undefined) error.details = meta.details;
  return error;
}


export function extractSkillReadContent(data: unknown): string {
  const root = toRecord(data);
  const rootData = toRecord(root.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates: unknown[] = [
    data,
    root.content,
    root.text,
    rootData.content,
    rootData.text,
    rootResponse.content,
    rootResponse.text,
    rootResponseData.content,
    rootResponseData.text,
    rootResponseInnerData.content,
    rootResponseInnerData.text,
    rootResult.content,
    rootResult.text,
  ];
  for (const item of candidates) {
    if (typeof item === "string") return item;
  }
  throw new Error(
    `文件读取工具未返回 content 文本: ${safeStringify(data, 1200)}`,
  );
}


export function toBrowserUserDisplayPath(location: string): string {
  const normalized = String(location || "").trim();
  if (!normalized) return "";
  if (!isVirtualUri(normalized)) return normalized;
  const rest = normalized.slice("mem://".length).replace(/^\/+/, "");
  return rest ? `/mem/${rest}` : "/mem";
}


export function buildSkillReferenceDirectoryRef(
  skill: SkillMetadata,
): PromptContextRefInput | null {
  const location = buildSkillChildLocation(skill.location, "references");
  if (!location) return null;
  const idSeed = String(skill.id || skill.name || "skill")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  if (isVirtualUri(location)) {
    return {
      id: `skill_ref_${idSeed}`,
      raw: `@${toBrowserUserDisplayPath(location)}`,
      displayPath: toBrowserUserDisplayPath(location),
      source: "skill_reference",
      syntax: "browser_mount",
      runtimeHint: "browser",
      locator: location,
    };
  }
  return {
    id: `skill_ref_${idSeed}`,
    raw: `@${location}`,
    displayPath: location,
    source: "skill_reference",
    syntax: location.startsWith("~") ? "host_home" : "host_absolute",
    runtimeHint: "host",
    locator: location,
  };
}


export function buildSkillChildLocation(
  location: string,
  relativePath: string,
): string {
  const normalizedLocation = String(location || "").trim();
  const normalizedRelative = String(relativePath || "")
    .trim()
    .replace(/^\.\//,  "")
    .replace(/^\/+/, "");
  if (!normalizedLocation) return "";
  if (!normalizedRelative) return "";
  if (normalizedRelative.includes("..")) {
    throw new Error("skill path \u4E0D\u80FD\u5305\u542B ..");
  }
  const cut = normalizedLocation.lastIndexOf("/");
  const base =
    cut >= 0 ? normalizedLocation.slice(0, cut) : normalizedLocation;
  return `${base}/${normalizedRelative}`;
}

export function buildSkillPackageRootLocation(location: string): string {
  const normalizedLocation = String(location || "").trim();
  if (!normalizedLocation) return "";
  const cut = normalizedLocation.lastIndexOf("/");
  return cut >= 0 ? normalizedLocation.slice(0, cut) : normalizedLocation;
}

// --- Functions moved from runtime-loop.browser.ts (dispatch-only) ---

export function isNonEmptyToolArgValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(toRecord(value)).length > 0;
  return true;
}

export function buildToolResponseEnvelope(
  type: string,
  data: unknown,
  extra: JsonRecord = {},
): JsonRecord {
  return {
    type,
    response: { ok: true, data },
    ...extra,
  };
}

export function mapVerifyReasonToFailureReason(
  rawVerifyReason: unknown,
): "failed_verify" | "progress_uncertain" {
  const verifyReason = String(rawVerifyReason || "")
    .trim()
    .toLowerCase();
  if (
    [
      "verify_skipped",
      "verify_policy_off",
      "verify_not_supported_for_bridge",
      "verify_missing_tab_id",
    ].includes(verifyReason)
  ) {
    return "progress_uncertain";
  }
  return "failed_verify";
}

// --- Factory deps ---

export interface ToolDispatchDeps {
  orchestrator: BrainOrchestrator;
  infra: RuntimeInfraHandler;
  executeStep: (input: {
    sessionId: string;
    mode?: ExecuteMode;
    capability?: ExecuteCapability;
    action: string;
    args?: JsonRecord;
    verifyPolicy?: StepVerifyPolicy;
  }) => Promise<ExecuteStepResult>;
}

export function createToolDispatcher(deps: ToolDispatchDeps) {
  const { orchestrator, infra, executeStep } = deps;

  // --- Closure-dependent helpers ---

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

  async function invokeBridgeFrameWithRetry(
    sessionId: string,
    toolName: string,
    frame: JsonRecord,
    capability: ExecuteCapability | undefined,
    autoRetryMax = TOOL_AUTO_RETRY_MAX,
  ): Promise<JsonRecord> {
    const normalizedToolName = String(toolName || "")
      .trim()
      .toLowerCase();
    const invokeId = String(frame.id || `invoke-${crypto.randomUUID()}`);
    const frameWithInvokeId: JsonRecord = {
      ...frame,
      id: invokeId,
    };
    const totalAttempts = Math.max(1, autoRetryMax + 1);
    let lastFailure: ExecuteStepResult | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      const invoke = await executeStep({
        sessionId,
        capability,
        action: "invoke",
        args: {
          frame: frameWithInvokeId,
        },
      });
      if (invoke.ok) {
        if (BASH_RUNTIME_TOOL_NAMES.has(normalizedToolName)) {
          const outcome = extractBashExecOutcome(invoke.data);
          if (outcome && outcome.exitCode !== null && outcome.exitCode !== 0) {
            return buildBashExitFailureEnvelope(toolName, invoke, outcome);
          }
        }
        return buildToolResponseEnvelope("invoke", invoke.data, {
          capabilityUsed: invoke.capabilityUsed || capability,
          modeUsed: invoke.modeUsed,
          providerId: invoke.providerId,
          fallbackFrom: invoke.fallbackFrom,
          attempt,
          autoRetried: attempt > 1,
        });
      }

      lastFailure = invoke;
      const code = normalizeErrorCode(invoke.errorCode);
      const canAutoRetry =
        attempt < totalAttempts && shouldAutoReplayToolCall(toolName, code);
      if (!canAutoRetry) break;
      await delay(computeToolRetryDelayMs(attempt));
    }

    const failure = lastFailure || {
      ok: false,
      modeUsed: "bridge" as ExecuteMode,
      verified: false,
      error: `${toolName} 执行失败`,
    };
    const errorCode = normalizeErrorCode(failure.errorCode);
    return {
      error: failure.error || `${toolName} 执行失败`,
      errorCode: errorCode || undefined,
      errorReason: "failed_execute",
      retryable:
        failure.retryable === true ||
        isRetryableToolErrorCode(toolName, errorCode),
      retryHint: buildToolRetryHint(toolName, errorCode),
      details: failure.errorDetails || null,
    };
  }

  // --- Schema validation ---

  function buildUnsupportedToolError(input: {
    requestedTool: string;
    resolvedTool: string;
    hasContract: boolean;
  }): JsonRecord {
    const unsupported = input.hasContract;
    return attachFailureProtocol(
      input.requestedTool || input.resolvedTool || "unknown_tool",
      {
        error: unsupported
          ? `工具已注册但当前 runtime 不支持执行: ${input.requestedTool}`
          : `未知工具: ${input.requestedTool}`,
        errorCode: unsupported ? "E_TOOL_UNSUPPORTED" : "E_TOOL",
        errorReason: "failed_execute",
        retryable: unsupported,
        retryHint: unsupported
          ? "Call a supported canonical tool name from tool list."
          : "Use list of available tools and retry with valid name.",
        details: {
          requestedTool: input.requestedTool,
          resolvedTool: input.resolvedTool,
          canonicalTool: input.resolvedTool || null,
          supportedTools: Array.from(RUNTIME_EXECUTABLE_TOOL_NAMES),
        },
      },
      {
        phase: "plan",
        category: "missing_target",
        resumeStrategy: unsupported ? "replan" : "replan",
      },
    );
  }

  function isElementRefOnlyConstraint(requiredSets: string[][]): boolean {
    if (requiredSets.length === 0) return false;
    return requiredSets.every(
      (set) =>
        set.length === 1 &&
        ["uid", "ref", "backendNodeId"].includes(String(set[0] || "").trim()),
    );
  }

  function matchesRequiredSet(
    args: JsonRecord,
    requiredSet: string[],
  ): boolean {
    if (requiredSet.length === 0) return true;
    for (const field of requiredSet) {
      if (!isNonEmptyToolArgValue(args[field])) return false;
    }
    return true;
  }

  function validateToolCallArgsAgainstSchema(input: {
    requestedTool: string;
    resolvedTool: string;
    args: JsonRecord;
    contract: ToolContract | null;
  }): { ok: true } | { ok: false; error: JsonRecord } {
    const schema = toRecord(input.contract?.parameters);
    if (Object.keys(schema).length === 0) return { ok: true };
    const normalizedTool = String(
      input.resolvedTool || input.requestedTool || "",
    )
      .trim()
      .toLowerCase();

    const requiredFields = normalizeSchemaRequiredList(schema.required);
    const missingRequired = requiredFields.filter(
      (field) => !isNonEmptyToolArgValue(input.args[field]),
    );
    if (missingRequired.length > 0) {
      return {
        ok: false,
        error: attachFailureProtocol(
          input.requestedTool || input.resolvedTool || "unknown_tool",
          {
            error: `${input.resolvedTool || input.requestedTool} 缺少必填参数: ${missingRequired.join(", ")}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: `补齐必填参数后重试 ${input.resolvedTool || input.requestedTool}。`,
            details: {
              missingRequired,
              providedKeys: Object.keys(input.args),
              schemaRequired: requiredFields,
            },
          },
          {
            phase: "plan",
            category: "missing_target",
            resumeStrategy: "replan",
          },
        ),
      };
    }

    const combinators: Array<"anyOf" | "oneOf" | "allOf"> = [
      "anyOf",
      "oneOf",
      "allOf",
    ];
    for (const combinator of combinators) {
      const requiredSets = readTopLevelConstraintRequiredSets(
        schema[combinator],
      );
      if (requiredSets.length === 0) continue;
      const matchedCount = requiredSets.filter((set) =>
        matchesRequiredSet(input.args, set),
      ).length;
      const satisfied =
        combinator === "anyOf"
          ? matchedCount >= 1
          : combinator === "oneOf"
            ? matchedCount === 1
            : matchedCount === requiredSets.length;
      if (satisfied) continue;

      const useRefRequiredCode =
        combinator === "anyOf" && isElementRefOnlyConstraint(requiredSets);
      const errorCode = useRefRequiredCode ? "E_REF_REQUIRED" : "E_ARGS";
      const retryHint = useRefRequiredCode
        ? `Call search_elements first, then retry ${input.resolvedTool || input.requestedTool} using uid/ref.`
        : `Adjust arguments to satisfy ${combinator} constraints, then retry ${input.resolvedTool || input.requestedTool}.`;
      const errorText = useRefRequiredCode
        ? "元素交互动作需要 uid/ref/backendNodeId（不支持仅 selector）。请先调用 search_elements，再用返回的 uid 执行。"
        : `${input.resolvedTool || input.requestedTool} 参数未满足 ${combinator} 约束`;
      return {
        ok: false,
        error: attachFailureProtocol(
          input.requestedTool || input.resolvedTool || "unknown_tool",
          {
            error: errorText,
            errorCode,
            errorReason: "failed_execute",
            retryable: true,
            retryHint,
            details: {
              combinator,
              matchedCount,
              requiredSets,
              providedKeys: Object.keys(input.args),
            },
          },
          {
            phase: "plan",
            category: "missing_target",
            resumeStrategy: "retry_with_fresh_snapshot",
          },
        ),
      };
    }

    if (
      normalizedTool === "fill_element_by_uid" &&
      !isNonEmptyToolArgValue(input.args.value)
    ) {
      return {
        ok: false,
        error: attachFailureProtocol(
          input.requestedTool || input.resolvedTool || "unknown_tool",
          {
            error: "fill_element_by_uid 需要非空 value",
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Provide non-empty value and retry fill_element_by_uid.",
          },
          {
            phase: "plan",
            category: "missing_target",
            resumeStrategy: "replan",
          },
        ),
      };
    }

    return { ok: true };
  }

  function resolveToolCallContext(
    toolCall: ToolCallItem,
  ):
    | { ok: true; value: ResolvedToolCallContext }
    | { ok: false; error: JsonRecord } {
    const requestedTool = String(toolCall.function.name || "").trim();
    const argsRaw = String(toolCall.function.arguments || "").trim();
    let args: JsonRecord = {};
    if (argsRaw) {
      try {
        const parsed = JSON.parse(argsRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return {
            ok: false,
            error: attachFailureProtocol(
              requestedTool || "unknown_tool",
              {
                error: "工具参数必须是 JSON object",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Pass arguments as JSON object and retry.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        args = parsed as JsonRecord;
      } catch (error) {
        return {
          ok: false,
          error: attachFailureProtocol(
            requestedTool || "unknown_tool",
            {
              error: `参数解析失败: ${error instanceof Error ? error.message : String(error)}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Fix JSON arguments and retry.",
            },
            {
              phase: "plan",
              category: "missing_target",
              resumeStrategy: "replan",
            },
          ),
        };
      }
    }

    const contract = orchestrator.resolveToolContract(requestedTool);
    const resolvedTool = String(contract?.name || requestedTool).trim();
    const customExecutionRaw = readContractExecution(contract);
    const customExecution =
      customExecutionRaw &&
      orchestrator.hasCapabilityProvider(customExecutionRaw.capability)
        ? customExecutionRaw
        : null;
    const executionTool =
      RUNTIME_EXECUTABLE_TOOL_NAMES.has(resolvedTool) || customExecution
        ? resolvedTool
        : "";
    if (!executionTool) {
      return {
        ok: false,
        error: buildUnsupportedToolError({
          requestedTool,
          resolvedTool,
          hasContract: Boolean(contract),
        }),
      };
    }

    const schemaValidation = validateToolCallArgsAgainstSchema({
      requestedTool,
      resolvedTool,
      args,
      contract,
    });
    if (!schemaValidation.ok) {
      return schemaValidation;
    }

    return {
      ok: true,
      value: {
        requestedTool,
        resolvedTool,
        executionTool,
        args,
        ...(customExecution
          ? {
              customExecution: {
                capability: customExecution.capability,
                ...(customExecution.mode ? { mode: customExecution.mode } : {}),
                ...(customExecution.action
                  ? { action: customExecution.action }
                  : {}),
                ...(customExecution.verifyPolicy
                  ? { verifyPolicy: customExecution.verifyPolicy }
                  : {}),
              },
            }
          : {}),
      },
    };
  }

  const INTERVENTION_CATALOG: Record<
    string,
    {
      type: string;
      name: string;
      description: string;
      enabled: boolean;
      inputSchema: JsonRecord;
    }
  > = {
    "monitor-operation": {
      type: "monitor-operation",
      name: "Monitor Operation",
      description:
        "Ask user to watch/confirm a browser operation before continuing.",
      enabled: true,
      inputSchema: {
        type: "object",
        properties: { instruction: { type: "string" } },
      },
    },
    "voice-input": {
      type: "voice-input",
      name: "Voice Input",
      description: "Ask user to provide missing information via voice/text.",
      enabled: true,
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string" } },
      },
    },
    "user-selection": {
      type: "user-selection",
      name: "User Selection",
      description: "Ask user to choose one option from AI-provided candidates.",
      enabled: true,
      inputSchema: {
        type: "object",
        properties: { options: { type: "array" } },
      },
    },
  };

  // --- Tool dispatch helpers ---

  const interventionRequests = new Map<
    string,
    {
      id: string;
      sessionId: string;
      type: string;
      params: JsonRecord;
      reason: string;
      timeoutSec: number;
      status: "pending" | "cancelled";
      createdAt: string;
    }
  >();

  function normalizeInterventionType(raw: unknown): string {
    const type = String(raw || "")
      .trim()
      .toLowerCase();
    if (!type) return "";
    return type;
  }

  // buildSkillChildLocation and buildSkillPackageRootLocation are at module scope

  async function resolveSkillByName(
    skillName: string,
  ): Promise<SkillMetadata | null> {
    const normalized = String(skillName || "").trim();
    if (!normalized) return null;
    const byId = await orchestrator.getSkill(normalized);
    if (byId) return byId;
    const all = await orchestrator.listSkills();
    const needle = normalized.toLowerCase();
    return (
      all.find((item) => String(item.id || "").toLowerCase() === needle) ||
      all.find((item) => String(item.name || "").toLowerCase() === needle) ||
      null
    );
  }

  async function readTextByLocation(
    sessionId: string,
    location: string,
  ): Promise<string> {
    const runtimeHint = isVirtualUri(location) ? "browser" : "local";
    const result = await executeStep({
      sessionId,
      capability: CAPABILITIES.fsRead,
      action: "invoke",
      args: {
        path: location,
        runtime: runtimeHint,
        frame: {
          tool: "read",
          args: {
            path: location,
            runtime: runtimeHint,
          },
        },
      },
      verifyPolicy: "off",
    });
    if (!result.ok) {
      throw new Error(result.error || `文件读取失败: ${location}`);
    }
    return extractSkillReadContent(result.data);
  }

  async function writeTextByLocation(
    sessionId: string,
    location: string,
    content: string,
  ): Promise<void> {
    const runtimeHint = isVirtualUri(location) ? "browser" : "local";
    const result = await executeStep({
      sessionId,
      capability: CAPABILITIES.fsWrite,
      action: "invoke",
      args: {
        path: location,
        runtime: runtimeHint,
        content,
        mode: "overwrite",
        frame: {
          tool: "write",
          args: {
            path: location,
            runtime: runtimeHint,
            content,
            mode: "overwrite",
          },
        },
      },
      verifyPolicy: "off",
    });
    if (!result.ok) {
      throw new Error(result.error || `文件写入失败: ${location}`);
    }
  }

  function normalizeDownloadFilename(input: string, fallback: string): string {
    const name = String(input || "").trim();
    const base = (name || fallback)
      .replace(/[\\/:*?\"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    return base || fallback;
  }

  function shellQuote(input: string): string {
    return `'${String(input || "").replace(/'/g, "'\"'\"'")}'`;
  }

  function toCoordinatePair(raw: unknown): [number, number] | null {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
  }

  async function buildToolPlan(
    sessionId: string,
    context: ResolvedToolCallContext,
  ): Promise<{ ok: true; plan: ToolPlan } | { ok: false; error: JsonRecord }> {
    const args = context.args;
    const buildUidActionPlan = async (
      toolName: string,
      kindValue: "click" | "fill" | "select" | "hover" | "read",
      options: {
        requireValue?: boolean;
      } = {},
    ): Promise<
      { ok: true; plan: ToolPlan } | { ok: false; error: JsonRecord }
    > => {
      const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
      if (!tabId) {
        return {
          ok: false,
          error: attachFailureProtocol(
            toolName,
            {
              error: `${toolName} 需要 tabId，当前无可用 tab`,
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: `Call get_all_tabs and retry ${toolName} with a valid tabId.`,
            },
            {
              phase: "plan",
              category: "missing_target",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          ),
        };
      }
      const uid = String(args.uid || "").trim();
      const ref = String(args.ref || "").trim();
      const selector = String(args.selector || "").trim();
      const backendNodeId = parsePositiveInt(args.backendNodeId);
      if (!uid && !ref && !backendNodeId) {
        return {
          ok: false,
          error: attachFailureProtocol(
            toolName,
            {
              error:
                "元素交互动作需要 uid/ref/backendNodeId（不支持仅 selector）。请先调用 search_elements，再用返回的 uid 执行。",
              errorCode: "E_REF_REQUIRED",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: `Call search_elements first, then retry ${toolName} using uid/ref.`,
            },
            {
              phase: "plan",
              category: "missing_target",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          ),
        };
      }
      const value = args.value == null ? "" : String(args.value);
      if (options.requireValue === true && !value.trim()) {
        return {
          ok: false,
          error: attachFailureProtocol(
            toolName,
            {
              error: `${toolName} 需要非空 value`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: `Provide value and retry ${toolName}.`,
            },
            {
              phase: "plan",
              category: "missing_target",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          ),
        };
      }
      return {
        ok: true,
        plan: {
          kind: "step.element_action",
          toolName: toolName as
            | "click"
            | "fill_element_by_uid"
            | "select_option_by_uid"
            | "hover_element_by_uid"
            | "get_editor_value"
            | "scroll_to_element",
          capability: CAPABILITIES.browserAction,
          tabId,
          kindValue,
          action: {
            kind: kindValue,
            uid: uid || undefined,
            ref: ref || uid || undefined,
            selector: selector || undefined,
            backendNodeId: backendNodeId || undefined,
            value,
            expect: args.expect,
            forceFocus: args.forceFocus === true,
            requireFocus: args.requireFocus === true,
          },
          expect: args.expect,
        },
      };
    };

    const buildTabActionPlan = async (
      toolName: "press_key" | "scroll_page" | "navigate_tab",
      kindValue: "press" | "scroll" | "navigate",
    ): Promise<
      { ok: true; plan: ToolPlan } | { ok: false; error: JsonRecord }
    > => {
      const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
      if (!tabId) {
        return {
          ok: false,
          error: attachFailureProtocol(
            toolName,
            {
              error: `${toolName} 需要 tabId，当前无可用 tab`,
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: `Call get_all_tabs and retry ${toolName} with a valid tabId.`,
            },
            {
              phase: "plan",
              category: "missing_target",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          ),
        };
      }

      const action: JsonRecord = {
        kind: kindValue,
        expect: args.expect,
        forceFocus: args.forceFocus === true,
        requireFocus: args.requireFocus === true,
      };

      if (kindValue === "press") {
        const key = String(args.key || args.value || "").trim();
        if (!key) {
          return {
            ok: false,
            error: attachFailureProtocol(
              toolName,
              {
                error: "press_key 需要 key",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide key (e.g. Enter) and retry press_key.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        action.key = key;
        action.value = key;
      } else if (kindValue === "scroll") {
        const delta = Number(args.deltaY ?? args.value ?? args.y ?? 600);
        action.value = Number.isFinite(delta) ? delta : 600;
      } else if (kindValue === "navigate") {
        const url = String(args.url || "").trim();
        if (!url) {
          return {
            ok: false,
            error: attachFailureProtocol(
              toolName,
              {
                error: "navigate_tab 需要 url",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide url and retry navigate_tab.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        action.url = url;
      }

      return {
        ok: true,
        plan: {
          kind: "step.element_action",
          toolName,
          capability: CAPABILITIES.browserAction,
          tabId,
          kindValue,
          action,
          expect: args.expect,
        },
      };
    };

    const resolveBrowserRuntime = async (
      raw: unknown,
    ): Promise<"browser" | "sandbox"> => {
      const cfgRaw = await callInfra(infra, { type: "config.get" }).catch(
        () => ({}) as JsonRecord,
      );
      const cfg = extractLlmConfig(toRecord(cfgRaw));
      const strategy = normalizeBrowserRuntimeStrategy(
        cfg.browserRuntimeStrategy,
        "browser-first",
      );
      const hint = String(raw || "").trim();
      if (hint) {
        return resolveBrowserRuntimeHint(raw, strategy);
      }
      return resolveBrowserRuntimeHint(undefined, strategy);
    };

    switch (context.executionTool) {
      case "host_bash":
      case "browser_bash": {
        const command = String(args.command || "").trim();
        if (!command)
          return {
            ok: false,
            error: { error: `${context.executionTool} 需要 command` },
          };
        const forcedRuntime =
          context.executionTool === "host_bash" ? "local" : "sandbox";
        const timeoutMs =
          args.timeoutMs == null
            ? undefined
            : normalizeIntInRange(
                args.timeoutMs,
                DEFAULT_BASH_TIMEOUT_MS,
                MIN_BASH_TIMEOUT_MS,
                MAX_BASH_TIMEOUT_MS,
              );
        return {
          ok: true,
          plan: {
            kind: "bridge",
            toolName: context.executionTool as "host_bash" | "browser_bash",
            capability: CAPABILITIES.processExec,
            frame: {
              tool: "bash",
              args: {
                cmdId: "bash.exec",
                args: [command],
                runtime: forcedRuntime,
                ...(timeoutMs == null ? {} : { timeoutMs }),
              },
            },
          },
        };
      }
      case "host_read_file":
      case "browser_read_file": {
        const path = String(args.path || "").trim();
        if (!path)
          return {
            ok: false,
            error: { error: `${context.executionTool} 需要 path` },
          };
        const forcedRuntime =
          context.executionTool === "host_read_file"
            ? "local"
            : await resolveBrowserRuntime(args.runtime);
        const invokeArgs: JsonRecord = { path };
        if (args.offset != null) invokeArgs.offset = args.offset;
        if (args.limit != null) invokeArgs.limit = args.limit;
        invokeArgs.runtime = forcedRuntime;
        return {
          ok: true,
          plan: {
            kind: "bridge",
            toolName: context.executionTool as
              | "host_read_file"
              | "browser_read_file",
            capability: CAPABILITIES.fsRead,
            frame: {
              tool: "read",
              args: invokeArgs,
            },
          },
        };
      }
      case "host_write_file":
      case "browser_write_file": {
        const path = String(args.path || "").trim();
        if (!path)
          return {
            ok: false,
            error: { error: `${context.executionTool} 需要 path` },
          };
        const forcedRuntime =
          context.executionTool === "host_write_file"
            ? "local"
            : await resolveBrowserRuntime(args.runtime);
        return {
          ok: true,
          plan: {
            kind: "bridge",
            toolName: context.executionTool as
              | "host_write_file"
              | "browser_write_file",
            capability: CAPABILITIES.fsWrite,
            frame: {
              tool: "write",
              args: {
                path,
                content: String(args.content || ""),
                mode: String(args.mode || "overwrite"),
                runtime: forcedRuntime,
              },
            },
          },
        };
      }
      case "host_edit_file":
      case "browser_edit_file": {
        const path = String(args.path || "").trim();
        if (!path)
          return {
            ok: false,
            error: { error: `${context.executionTool} 需要 path` },
          };
        const forcedRuntime =
          context.executionTool === "host_edit_file"
            ? "local"
            : await resolveBrowserRuntime(args.runtime);
        return {
          ok: true,
          plan: {
            kind: "bridge",
            toolName: context.executionTool as
              | "host_edit_file"
              | "browser_edit_file",
            capability: CAPABILITIES.fsEdit,
            frame: {
              tool: "edit",
              args: {
                path,
                edits: Array.isArray(args.edits) ? args.edits : [],
                runtime: forcedRuntime,
              },
            },
          },
        };
      }
      case "get_all_tabs":
        return { ok: true, plan: { kind: "local.get_all_tabs" } };
      case "get_current_tab":
        return { ok: true, plan: { kind: "local.current_tab" } };
      case "create_new_tab": {
        const rawUrl = String(args.url || "").trim();
        if (!rawUrl)
          return { ok: false, error: { error: "create_new_tab 需要 url" } };
        return {
          ok: true,
          plan: {
            kind: "local.create_new_tab",
            args: {
              url: rawUrl,
              active: args.active,
            },
          },
        };
      }
      case "get_tab_info": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "get_tab_info",
              {
                error: "get_tab_info 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry get_tab_info with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.get_tab_info",
            tabId,
          },
        };
      }
      case "close_tab": {
        const explicitTabId = parsePositiveInt(args.tabId);
        if (explicitTabId) {
          return {
            ok: true,
            plan: {
              kind: "local.close_tab",
              tabId: explicitTabId,
            },
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.close_tab",
            tabId: null,
          },
        };
      }
      case "ungroup_tabs": {
        const windowId = parsePositiveInt(args.windowId);
        return {
          ok: true,
          plan: {
            kind: "local.ungroup_tabs",
            windowId: windowId || null,
          },
        };
      }
      case "search_elements": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "search_elements",
              {
                error: "search_elements 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry search_elements with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const maxResultsRaw = Number(args.maxResults);
        const maxResults = Number.isFinite(maxResultsRaw)
          ? Math.max(1, Math.min(120, Math.floor(maxResultsRaw)))
          : 20;
        const query = String(args.query || "").trim();
        return {
          ok: true,
          plan: {
            kind: "step.search_elements",
            capability: CAPABILITIES.browserSnapshot,
            tabId,
            query,
            maxResults,
            options: {
              mode: "interactive",
              selector: String(args.selector || ""),
              filter: inferSearchElementsFilter(query),
              format: "json",
              diff: args.diff === true,
              maxTokens: args.maxTokens,
              depth: args.depth,
              noAnimations: args.noAnimations === true,
            },
          },
        };
      }
      case "click":
        return await buildUidActionPlan("click", "click");
      case "fill_element_by_uid":
        return await buildUidActionPlan("fill_element_by_uid", "fill");
      case "select_option_by_uid":
        return await buildUidActionPlan("select_option_by_uid", "select", {
          requireValue: true,
        });
      case "hover_element_by_uid":
        return await buildUidActionPlan("hover_element_by_uid", "hover");
      case "get_editor_value":
        return await buildUidActionPlan("get_editor_value", "read");
      case "press_key":
        return await buildTabActionPlan("press_key", "press");
      case "scroll_page":
        return await buildTabActionPlan("scroll_page", "scroll");
      case "navigate_tab":
        return await buildTabActionPlan("navigate_tab", "navigate");
      case "scroll_to_element":
        return await buildUidActionPlan("scroll_to_element", "hover");
      case "get_page_metadata": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "get_page_metadata",
              {
                error: "get_page_metadata 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry get_page_metadata with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const expression = `(() => {
          const getMeta = (name, property) => {
            const selector = property ? 'meta[property=\"' + property + '\"]' : 'meta[name=\"' + name + '\"]';
            const el = document.querySelector(selector);
            return el && typeof el.content === 'string' ? el.content : '';
          };
          return {
            title: document.title || '',
            url: location.href,
            description: getMeta('description', '') || getMeta('', 'og:description'),
            keywords: getMeta('keywords', ''),
            author: getMeta('author', '') || getMeta('', 'og:author'),
            ogImage: getMeta('', 'og:image'),
            favicon:
              (document.querySelector('link[rel=\"icon\"]') || document.querySelector('link[rel=\"shortcut icon\"]'))?.href || ''
          };
        })()`;
        return {
          ok: true,
          plan: {
            kind: "step.script_action",
            toolName: "get_page_metadata",
            capability: CAPABILITIES.browserAction,
            tabId,
            expression,
            expect: null,
          },
        };
      }
      case "highlight_element": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "highlight_element",
              {
                error: "highlight_element 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry highlight_element with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const selector = String(args.selector || "").trim();
        if (!selector) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "highlight_element",
              {
                error: "highlight_element 需要 selector",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide selector and retry highlight_element.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const color = String(args.color || "#00d4ff");
        const durationMs = Number(args.durationMs ?? 1600);
        const normalizedDuration = Number.isFinite(durationMs)
          ? Math.max(0, Math.min(30_000, Math.floor(durationMs)))
          : 1600;
        const expression = `(() => {
          const selector = ${JSON.stringify(selector)};
          const color = ${JSON.stringify(color)};
          const duration = ${normalizedDuration};
          const nodes = Array.from(document.querySelectorAll(selector));
          if (!nodes.length) return { success: false, error: 'selector not found', selector };
          const marker = 'bbl-highlight-' + Date.now();
          for (const node of nodes) {
            const el = node;
            if (!(el instanceof HTMLElement)) continue;
            el.setAttribute('data-bbl-highlight', marker);
            el.style.outline = '2px solid ' + color;
            el.style.outlineOffset = '2px';
            el.style.boxShadow = '0 0 0 3px color-mix(in srgb, ' + color + ' 30%, transparent)';
          }
          if (duration > 0) {
            setTimeout(() => {
              for (const el of document.querySelectorAll('[data-bbl-highlight=\"' + marker + '\"]')) {
                if (!(el instanceof HTMLElement)) continue;
                el.style.outline = '';
                el.style.outlineOffset = '';
                el.style.boxShadow = '';
                el.removeAttribute('data-bbl-highlight');
              }
            }, duration);
          }
          return { success: true, count: nodes.length, selector, color, durationMs: duration, url: location.href, title: document.title };
        })()`;
        return {
          ok: true,
          plan: {
            kind: "step.script_action",
            toolName: "highlight_element",
            capability: CAPABILITIES.browserAction,
            tabId,
            expression,
            expect: normalizeVerifyExpect(args.expect || null),
          },
        };
      }
      case "highlight_text_inline": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "highlight_text_inline",
              {
                error: "highlight_text_inline 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry highlight_text_inline with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const selector = String(args.selector || "").trim();
        const searchText = String(args.searchText || "").trim();
        if (!selector || !searchText) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "highlight_text_inline",
              {
                error: "highlight_text_inline 需要 selector 和 searchText",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide selector + searchText and retry highlight_text_inline.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const caseSensitive = args.caseSensitive === true;
        const wholeWords = args.wholeWords === true;
        const highlightColor = String(args.highlightColor || "#DC143C");
        const backgroundColor = String(args.backgroundColor || "transparent");
        const fontWeight = String(args.fontWeight || "bold");
        const expression = `(() => {
          const selector = ${JSON.stringify(selector)};
          const searchText = ${JSON.stringify(searchText)};
          const caseSensitive = ${caseSensitive};
          const wholeWords = ${wholeWords};
          const highlightColor = ${JSON.stringify(highlightColor)};
          const backgroundColor = ${JSON.stringify(backgroundColor)};
          const fontWeight = ${JSON.stringify(fontWeight)};
          const nodes = Array.from(document.querySelectorAll(selector));
          if (!nodes.length) return { success: false, error: 'selector not found', selector };
          const escaped = searchText.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&');
          const source = wholeWords ? ('\\\\b' + escaped + '\\\\b') : escaped;
          const flags = caseSensitive ? 'g' : 'gi';
          const re = new RegExp(source, flags);
          let count = 0;
          for (const root of nodes) {
            if (!(root instanceof HTMLElement)) continue;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            while (walker.nextNode()) textNodes.push(walker.currentNode);
            for (const node of textNodes) {
              const text = node.textContent || '';
              if (!re.test(text)) continue;
              re.lastIndex = 0;
              const frag = document.createDocumentFragment();
              let last = 0;
              let hit;
              while ((hit = re.exec(text)) !== null) {
                if (hit.index > last) frag.appendChild(document.createTextNode(text.slice(last, hit.index)));
                const span = document.createElement('span');
                span.textContent = hit[0];
                span.style.color = highlightColor;
                span.style.backgroundColor = backgroundColor;
                span.style.fontWeight = fontWeight;
                span.setAttribute('data-bbl-inline-highlight', '1');
                frag.appendChild(span);
                count += 1;
                last = hit.index + hit[0].length;
              }
              if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
              node.parentNode?.replaceChild(frag, node);
            }
          }
          return { success: true, selector, searchText, matches: count, url: location.href, title: document.title };
        })()`;
        return {
          ok: true,
          plan: {
            kind: "step.script_action",
            toolName: "highlight_text_inline",
            capability: CAPABILITIES.browserAction,
            tabId,
            expression,
            expect: normalizeVerifyExpect(args.expect || null),
          },
        };
      }
      case "capture_screenshot":
      case "capture_tab_screenshot":
      case "capture_screenshot_with_highlight": {
        const requested = context.executionTool as
          | "capture_screenshot"
          | "capture_tab_screenshot"
          | "capture_screenshot_with_highlight";
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              requested,
              {
                error: `${requested} 需要 tabId，当前无可用 tab`,
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint: `Call get_all_tabs and retry ${requested} with a valid tabId.`,
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const format =
          String(args.format || "png")
            .trim()
            .toLowerCase() === "jpeg"
            ? "jpeg"
            : "png";
        const qualityRaw = Number(args.quality);
        const quality = Number.isFinite(qualityRaw)
          ? Math.max(0, Math.min(100, Math.floor(qualityRaw)))
          : null;
        return {
          ok: true,
          plan: {
            kind: "step.capture_screenshot",
            toolName: requested,
            tabId,
            format,
            quality,
            selector: String(args.selector || "").trim(),
            sendToLLM: args.sendToLLM !== false,
          },
        };
      }
      case "download_image": {
        const imageData = String(args.imageData || "").trim();
        if (!imageData.startsWith("data:image/")) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "download_image",
              {
                error: "download_image 需要 data:image/* 格式 imageData",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide a valid data:image URL and retry download_image.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "download_image",
              {
                error: "download_image 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry download_image with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const fallbackName = `image-${Date.now()}.png`;
        const filename = normalizeDownloadFilename(
          String(args.filename || ""),
          fallbackName,
        );
        return {
          ok: true,
          plan: {
            kind: "step.download_image",
            tabId,
            imageData,
            filename,
          },
        };
      }
      case "download_chat_images": {
        const rawMessages = Array.isArray(args.messages)
          ? (args.messages as unknown[])
          : [];
        const strategy = String(args.filenamingStrategy || "descriptive")
          .trim()
          .toLowerCase();
        const files: Array<{ imageData: string; filename: string }> = [];
        let index = 0;
        for (const message of rawMessages) {
          const messageRecord = toRecord(message);
          const parts = Array.isArray(messageRecord.parts)
            ? (messageRecord.parts as unknown[])
            : [];
          for (const part of parts) {
            const partRecord = toRecord(part);
            if (
              String(partRecord.type || "")
                .trim()
                .toLowerCase() !== "image"
            )
              continue;
            const imageData = String(partRecord.imageData || "").trim();
            if (!imageData.startsWith("data:image/")) continue;
            index += 1;
            const imageTitle = String(partRecord.imageTitle || "").trim();
            const messageId = String(messageRecord.id || "").trim();
            const stem =
              strategy === "sequential"
                ? `image-${String(index).padStart(3, "0")}`
                : strategy === "timestamp"
                  ? `image-${Date.now()}-${index}`
                  : imageTitle || messageId || `image-${index}`;
            files.push({
              imageData,
              filename: normalizeDownloadFilename(stem, `image-${index}`),
            });
          }
        }
        if (!files.length) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "download_chat_images",
              {
                error: "download_chat_images 未找到可下载的 imageData",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide messages[].parts[].imageData with data:image URL.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "download_chat_images",
              {
                error: "download_chat_images 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry download_chat_images with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.download_chat_images",
            tabId,
            files,
          },
        };
      }
      case "computer": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "computer",
              {
                error: "computer 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry computer with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const action = String(args.action || "")
          .trim()
          .toLowerCase();
        if (!action) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "computer",
              {
                error: "computer 需要 action",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide action and retry computer.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.computer",
            tabId,
            action,
            coordinate: toCoordinatePair(args.coordinate),
            startCoordinate: toCoordinatePair(args.start_coordinate),
            text: String(args.text || "").trim(),
            scrollDirection: String(args.scroll_direction || "")
              .trim()
              .toLowerCase(),
            scrollAmount: Number.isFinite(Number(args.scroll_amount))
              ? Number(args.scroll_amount)
              : null,
            durationSec: Number.isFinite(Number(args.duration))
              ? Number(args.duration)
              : null,
            uid: String(args.uid || "").trim(),
            selector: String(args.selector || "").trim(),
          },
        };
      }
      case "list_interventions":
        return {
          ok: true,
          plan: {
            kind: "local.list_interventions",
            enabledOnly: args.enabledOnly === true,
          },
        };
      case "get_intervention_info": {
        const type = normalizeInterventionType(args.type);
        if (!type) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "get_intervention_info",
              {
                error: "get_intervention_info 需要 type",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide intervention type and retry get_intervention_info.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.get_intervention_info",
            interventionType: type,
          },
        };
      }
      case "request_intervention": {
        const type = normalizeInterventionType(args.type);
        if (!type) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "request_intervention",
              {
                error: "request_intervention 需要 type",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide intervention type and retry request_intervention.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        const timeoutSecRaw = Number(args.timeout ?? 300);
        const timeoutSec = Number.isFinite(timeoutSecRaw)
          ? Math.max(30, Math.min(3600, Math.floor(timeoutSecRaw)))
          : 300;
        return {
          ok: true,
          plan: {
            kind: "local.request_intervention",
            sessionId,
            interventionType: type,
            params: toRecord(args.params),
            timeoutSec,
            reason: String(args.reason || "").trim(),
          },
        };
      }
      case "cancel_intervention":
        return {
          ok: true,
          plan: {
            kind: "local.cancel_intervention",
            sessionId,
            requestId: String(args.id || "").trim(),
          },
        };
      case "list_skills":
        return {
          ok: true,
          plan: {
            kind: "local.list_skills",
            enabledOnly: args.enabledOnly === true,
          },
        };
      case "create_skill": {
        const skillName = String(args.name || args.id || "").trim();
        const description = String(args.description || "").trim();
        if (!skillName || !description) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "create_skill",
              {
                error: "create_skill 需要 name/id 和 description",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide name(id optional) + description and retry create_skill.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.create_skill",
            sessionId,
            input: args,
          },
        };
      }
      case "get_skill_info": {
        const skillName = String(args.skillName || args.name || "").trim();
        if (!skillName) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "get_skill_info",
              {
                error: "get_skill_info 需要 skillName",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide skillName and retry get_skill_info.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.get_skill_info",
            skillName,
          },
        };
      }
      case "load_skill": {
        const skillName = String(args.name || args.skillName || "").trim();
        if (!skillName) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "load_skill",
              {
                error: "load_skill 需要 name",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide skill name and retry load_skill.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.load_skill",
            sessionId,
            skillName,
          },
        };
      }
      case "read_skill_reference": {
        const skillName = String(args.skillName || args.name || "").trim();
        const refPath = String(args.refPath || "").trim();
        if (!skillName || !refPath) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "read_skill_reference",
              {
                error: "read_skill_reference 需要 skillName 和 refPath",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide skillName + refPath and retry read_skill_reference.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.read_skill_reference",
            sessionId,
            skillName,
            refPath,
          },
        };
      }
      case "get_skill_asset": {
        const skillName = String(args.skillName || args.name || "").trim();
        const assetPath = String(args.assetPath || "").trim();
        if (!skillName || !assetPath) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "get_skill_asset",
              {
                error: "get_skill_asset 需要 skillName 和 assetPath",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide skillName + assetPath and retry get_skill_asset.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.get_skill_asset",
            sessionId,
            skillName,
            assetPath,
          },
        };
      }
      case "execute_skill_script": {
        const skillName = String(args.skillName || args.name || "").trim();
        const scriptPath = String(args.scriptPath || "").trim();
        if (!skillName || !scriptPath) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "execute_skill_script",
              {
                error: "execute_skill_script 需要 skillName 和 scriptPath",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Provide skillName + scriptPath and retry execute_skill_script.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "local.execute_skill_script",
            sessionId,
            skillName,
            scriptPath,
            scriptArgs: args.args,
          },
        };
      }
      case "fill_form": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "fill_form",
              {
                error: "fill_form 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry fill_form with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const rawElements = Array.isArray(args.elements)
          ? (args.elements as unknown[])
          : [];
        const elements = rawElements
          .map((item) => toRecord(item))
          .map((item) => ({
            uid: String(item.uid || "").trim(),
            ref: String(item.ref || "").trim(),
            selector: String(item.selector || "").trim(),
            backendNodeId: parsePositiveInt(item.backendNodeId),
            value: String(item.value || ""),
          }))
          .filter((item) => item.value.length > 0);
        if (elements.length === 0) {
          return {
            ok: false,
            error: {
              error: "fill_form 需要 elements 且每项至少包含 value",
              errorCode: "E_ARGS",
            },
          };
        }
        if (
          elements.some(
            (item) =>
              !item.uid && !item.ref && !item.backendNodeId && !item.selector,
          )
        ) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "fill_form",
              {
                error:
                  "fill_form 每个字段都需要 uid/ref/backendNodeId（或 selector 兜底）。请先调用 search_elements。",
                errorCode: "E_REF_REQUIRED",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call search_elements and map each field to uid/ref before fill_form.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.fill_form",
            capability: CAPABILITIES.browserAction,
            tabId,
            elements,
            submit:
              Object.keys(toRecord(args.submit)).length > 0
                ? toRecord(args.submit)
                : null,
            expect: normalizeVerifyExpect(args.expect || {}) || {},
          },
        };
      }
      case "browser_verify": {
        const tabId = await resolveRunScopeTabId(sessionId, args.tabId);
        if (!tabId) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "browser_verify",
              {
                error: "browser_verify 需要 tabId，当前无可用 tab",
                errorCode: "E_NO_TAB",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Call get_all_tabs and retry browser_verify with a valid tabId.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            ),
          };
        }
        const verifyExpect = normalizeVerifyExpect(args.expect || args) || {};
        if (Object.keys(verifyExpect).length === 0) {
          return {
            ok: false,
            error: attachFailureProtocol(
              "browser_verify",
              {
                error:
                  "browser_verify 需要明确 expect（如 url/title/text/selector/urlChanged）",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide explicit expect and retry browser_verify.",
              },
              {
                phase: "plan",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            ),
          };
        }
        return {
          ok: true,
          plan: {
            kind: "step.browser_verify",
            capability: CAPABILITIES.browserVerify,
            tabId,
            verifyExpect,
          },
        };
      }
      default:
        if (context.customExecution) {
          return {
            ok: true,
            plan: {
              kind: "custom.invoke",
              toolName: context.resolvedTool,
              capability: context.customExecution.capability,
              ...(context.customExecution.mode
                ? { mode: context.customExecution.mode }
                : {}),
              action: String(
                context.customExecution.action ||
                  context.resolvedTool ||
                  context.requestedTool,
              ).trim(),
              args,
              ...(context.customExecution.verifyPolicy
                ? { verifyPolicy: context.customExecution.verifyPolicy }
                : {}),
            },
          };
        }
        return {
          ok: false,
          error: buildUnsupportedToolError({
            requestedTool: context.requestedTool,
            resolvedTool: context.resolvedTool,
            hasContract: true,
          }),
        };
    }
  }

  async function dispatchToolPlan(
    sessionId: string,
    plan: ToolPlan,
  ): Promise<JsonRecord> {
    switch (plan.kind) {
      case "bridge":
        return await invokeBridgeFrameWithRetry(
          sessionId,
          plan.toolName,
          plan.frame,
          plan.capability,
        );
      case "custom.invoke": {
        const out = await executeStep({
          sessionId,
          ...(plan.mode ? { mode: plan.mode } : {}),
          capability: plan.capability,
          action: plan.action,
          args: plan.args,
          verifyPolicy: plan.verifyPolicy || "off",
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            plan.toolName,
            out,
            `${plan.toolName} 执行失败`,
            `Retry ${plan.toolName} with valid arguments/capability provider.`,
            {
              phase: "execute",
              resumeStrategy: "replan",
            },
          );
        }
        return buildToolResponseEnvelope("invoke", out.data, {
          capabilityUsed: out.capabilityUsed || plan.capability,
          modeUsed: out.modeUsed,
          providerId: out.providerId,
          fallbackFrom: out.fallbackFrom,
        });
      }
      case "local.get_all_tabs": {
        const tabs = await queryAllTabsForRuntime();
        const activeTabId = await getActiveTabIdForRuntime();
        return buildToolResponseEnvelope("tabs", {
          count: tabs.length,
          activeTabId,
          tabs,
        });
      }
      case "local.current_tab": {
        const tabs = await queryAllTabsForRuntime();
        const activeTabId = await getActiveTabIdForRuntime();
        const tab =
          tabs.find((item: JsonRecord) => Number(item.id) === Number(activeTabId)) || null;
        return buildToolResponseEnvelope("tabs", {
          activeTabId,
          tab,
        });
      }
      case "local.create_new_tab": {
        const created = await chrome.tabs.create({
          url: String(plan.args.url || ""),
          active: plan.args.active !== false,
        });
        return buildToolResponseEnvelope("tabs", {
          opened: true,
          tab: {
            id: created?.id || null,
            windowId: created?.windowId || null,
            active: created?.active === true,
            title: created?.title || "",
            url: created?.url || created?.pendingUrl || "",
          },
        });
      }
      case "local.get_tab_info": {
        const tab = await chrome.tabs.get(plan.tabId).catch(() => null);
        if (!tab?.id) {
          return attachFailureProtocol(
            "get_tab_info",
            {
              error: `tab 不存在: ${plan.tabId}`,
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint:
                "Call get_all_tabs and retry get_tab_info with a valid tabId.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          );
        }
        return buildToolResponseEnvelope("tab_info", {
          id: Number(tab.id),
          index: Number(tab.index || 0),
          windowId: Number(tab.windowId || 0),
          active: tab.active === true,
          pinned: tab.pinned === true,
          title: String(tab.title || ""),
          url: String(tab.url || tab.pendingUrl || ""),
        });
      }
      case "local.close_tab": {
        let tabId = plan.tabId;
        if (!tabId) {
          tabId = await getActiveTabIdForRuntime();
        }
        if (!tabId) {
          return attachFailureProtocol(
            "close_tab",
            {
              error: "close_tab 未找到可关闭 tab",
              errorCode: "E_NO_TAB",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Call get_all_tabs then retry close_tab with tabId.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          );
        }
        await chrome.tabs.remove(tabId).catch((error) => {
          throw createRuntimeError(
            `close_tab 失败: ${error instanceof Error ? error.message : String(error)}`,
            {
              code: "E_TOOL_EXECUTE",
              retryable: true,
            },
          );
        });
        return buildToolResponseEnvelope("close_tab", {
          success: true,
          tabId,
        });
      }
      case "local.ungroup_tabs": {
        const tabs = await chrome.tabs.query(
          plan.windowId ? { windowId: plan.windowId } : { currentWindow: true },
        );
        let ungroupedCount = 0;
        for (const tab of tabs) {
          if (!tab?.id) continue;
          if (
            typeof tab.groupId !== "number" ||
            tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
          )
            continue;
          await chrome.tabs.ungroup(tab.id).catch(() => undefined);
          ungroupedCount += 1;
        }
        return buildToolResponseEnvelope("ungroup_tabs", {
          success: true,
          windowId: plan.windowId || null,
          ungroupedCount,
        });
      }
      case "local.list_interventions": {
        const interventions = Object.values(INTERVENTION_CATALOG).filter(
          (item) => (plan.enabledOnly ? item.enabled : true),
        );
        return buildToolResponseEnvelope("list_interventions", {
          success: true,
          count: interventions.length,
          interventions,
        });
      }
      case "local.get_intervention_info": {
        const info = INTERVENTION_CATALOG[plan.interventionType];
        if (!info) {
          return attachFailureProtocol(
            "get_intervention_info",
            {
              error: `未知 intervention type: ${plan.interventionType}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Use list_interventions and retry with valid type.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "replan",
            },
          );
        }
        return buildToolResponseEnvelope("get_intervention_info", {
          success: true,
          intervention: info,
        });
      }
      case "local.request_intervention": {
        const info = INTERVENTION_CATALOG[plan.interventionType];
        if (!info) {
          return attachFailureProtocol(
            "request_intervention",
            {
              error: `未知 intervention type: ${plan.interventionType}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Use list_interventions and retry with valid type.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "replan",
            },
          );
        }
        const requestId = `ivr_${crypto.randomUUID()}`;
        interventionRequests.set(requestId, {
          id: requestId,
          sessionId: plan.sessionId,
          type: plan.interventionType,
          params: plan.params,
          reason: plan.reason,
          timeoutSec: plan.timeoutSec,
          status: "pending",
          createdAt: nowIso(),
        });
        return buildToolResponseEnvelope("request_intervention", {
          success: true,
          id: requestId,
          status: "pending",
          intervention: info,
          reason: plan.reason,
          params: plan.params,
          timeoutSec: plan.timeoutSec,
          message:
            "User intervention requested. Please wait for human feedback.",
        });
      }
      case "local.cancel_intervention": {
        const id = String(plan.requestId || "").trim();
        if (id) {
          const found = interventionRequests.get(id);
          if (!found) {
            return attachFailureProtocol(
              "cancel_intervention",
              {
                error: `intervention 不存在: ${id}`,
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint:
                  "Use request_intervention result id or omit id to cancel pending queue.",
              },
              {
                phase: "execute",
                category: "missing_target",
                resumeStrategy: "replan",
              },
            );
          }
          found.status = "cancelled";
          interventionRequests.set(id, found);
        }
        orchestrator.clearQueuedPrompts(plan.sessionId);
        return buildToolResponseEnvelope("cancel_intervention", {
          success: true,
          id: id || null,
          cancelled: id ? 1 : "all_pending_queue",
        });
      }
      case "local.list_skills": {
        const skills = await orchestrator.listSkills();
        const filtered = plan.enabledOnly
          ? skills.filter((item) => item.enabled)
          : skills;
        return buildToolResponseEnvelope("list_skills", {
          success: true,
          count: filtered.length,
          skills: filtered,
        });
      }
      case "local.create_skill": {
        const normalized = normalizeSkillCreateRequest(plan.input);
        for (const file of normalized.writes) {
          await writeTextByLocation(plan.sessionId, file.path, file.content);
        }
        const skill = await orchestrator.installSkill(normalized.skill, {
          replace: normalized.replace,
        });
        return buildToolResponseEnvelope("create_skill", {
          success: true,
          sessionId: plan.sessionId,
          skillId: skill.id,
          skill,
          root: normalized.root,
          skillDir: normalized.skillDir,
          location: skill.location,
          fileCount: normalized.writes.length,
          files: normalized.writes.map((item) => item.path),
        });
      }
      case "local.get_skill_info": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol(
            "get_skill_info",
            {
              error: `skill 不存在: ${plan.skillName}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint:
                "Use list_skills then retry get_skill_info with valid skillName.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "replan",
            },
          );
        }
        const base = String(skill.location || "").replace(/\/[^/]*$/, "");
        return buildToolResponseEnvelope("get_skill_info", {
          success: true,
          skill: {
            ...skill,
            paths: {
              scripts: `${base}/scripts/`,
              references: `${base}/references/`,
              assets: `${base}/assets/`,
            },
          },
        });
      }
      case "local.load_skill": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol(
            "load_skill",
            {
              error: `skill 不存在: ${plan.skillName}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint:
                "Use list_skills then retry load_skill with valid name.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "replan",
            },
          );
        }
        const content = await readTextByLocation(
          plan.sessionId,
          skill.location,
        );
        return buildToolResponseEnvelope("load_skill", {
          success: true,
          skill,
          content,
        });
      }
      case "local.read_skill_reference": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol(
            "read_skill_reference",
            {
              error: `skill 不存在: ${plan.skillName}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint:
                "Use list_skills then retry read_skill_reference with valid skillName.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "replan",
            },
          );
        }
        const normalizedRef = plan.refPath.startsWith("references/")
          ? plan.refPath
          : `references/${plan.refPath}`;
        const location = buildSkillChildLocation(skill.location, normalizedRef);
        const content = await readTextByLocation(plan.sessionId, location);
        return buildToolResponseEnvelope("read_skill_reference", {
          success: true,
          skill: {
            id: skill.id,
            name: skill.name,
          },
          refPath: normalizedRef,
          location,
          content,
        });
      }
      case "local.get_skill_asset": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol(
            "get_skill_asset",
            {
              error: `skill 不存在: ${plan.skillName}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint:
                "Use list_skills then retry get_skill_asset with valid skillName.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "replan",
            },
          );
        }
        const normalizedAsset = plan.assetPath.startsWith("assets/")
          ? plan.assetPath
          : `assets/${plan.assetPath}`;
        const location = buildSkillChildLocation(
          skill.location,
          normalizedAsset,
        );
        const content = await readTextByLocation(plan.sessionId, location);
        return buildToolResponseEnvelope("get_skill_asset", {
          success: true,
          skill: {
            id: skill.id,
            name: skill.name,
          },
          assetPath: normalizedAsset,
          location,
          content,
        });
      }
      case "local.execute_skill_script": {
        const skill = await resolveSkillByName(plan.skillName);
        if (!skill) {
          return attachFailureProtocol(
            "execute_skill_script",
            {
              error: `skill 不存在: ${plan.skillName}`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint:
                "Use list_skills then retry execute_skill_script with valid skillName.",
            },
            {
              phase: "execute",
              category: "missing_target",
              resumeStrategy: "replan",
            },
          );
        }
        const normalizedScript = plan.scriptPath.startsWith("scripts/")
          ? plan.scriptPath
          : `scripts/${plan.scriptPath}`;
        const location = buildSkillChildLocation(
          skill.location,
          normalizedScript,
        );
        const runtimeHint = isVirtualUri(location) ? "browser" : "local";
        const skillRootLocation = buildSkillPackageRootLocation(skill.location);
        const skillRuntimeCwd =
          skillRootLocation || (runtimeHint === "browser" ? "mem://" : "");

        const argPayload =
          plan.scriptArgs === undefined
            ? "{}"
            : safeStringify(plan.scriptArgs, 8_000);
        const ext = location.split(".").pop()?.toLowerCase() || "";
        const command = (() => {
          if (ext === "js" || ext === "mjs" || ext === "cjs") {
            return `node ${shellQuote(location)} ${shellQuote(argPayload)}`;
          }
          if (ext === "ts" || ext === "tsx") {
            return `bun ${shellQuote(location)} ${shellQuote(argPayload)}`;
          }
          if (ext === "sh") {
            return `bash ${shellQuote(location)} ${shellQuote(argPayload)}`;
          }
          return `bash ${shellQuote(location)} ${shellQuote(argPayload)}`;
        })();

        const out = await executeStep({
          sessionId: plan.sessionId,
          capability: CAPABILITIES.processExec,
          action: "invoke",
          args: {
            frame: {
              tool: "bash",
              args: {
                cmdId: "bash.exec",
                args: [command],
                runtime: runtimeHint,
                ...(skillRuntimeCwd ? { cwd: skillRuntimeCwd } : {}),
              },
            },
          },
          verifyPolicy: "off",
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            "execute_skill_script",
            out,
            "execute_skill_script 执行失败",
            "Check script path/runtime and retry execute_skill_script.",
            {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "replan",
            },
          );
        }
        const outcome = extractBashExecOutcome(out.data);
        if (outcome && outcome.exitCode !== null && outcome.exitCode !== 0) {
          if (runtimeHint === "browser") {
            return buildSkillScriptSandboxFailureEnvelope({
              invoke: out,
              outcome,
              location,
              scriptPath: normalizedScript,
              command,
              cwd: skillRuntimeCwd || undefined,
            });
          }
          return buildBashExitFailureEnvelope(
            "execute_skill_script",
            out,
            outcome,
          );
        }
        return buildToolResponseEnvelope("execute_skill_script", {
          success: true,
          executed: true,
          skill: {
            id: skill.id,
            name: skill.name,
          },
          scriptPath: normalizedScript,
          location,
          runtime: runtimeHint,
          cwd: skillRuntimeCwd || null,
          command,
          result: out.data,
        });
      }
      case "step.search_elements": {
        const out = await executeStep({
          sessionId,
          capability: plan.capability,
          action: "snapshot",
          args: {
            tabId: plan.tabId,
            options: plan.options,
          },
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            "search_elements",
            out,
            "search_elements 执行失败",
            "Take a fresh snapshot and retry search_elements with a valid scope.",
            {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          );
        }
        const snapshotData = toRecord(out.data);
        const rawNodes = Array.isArray(snapshotData.nodes)
          ? (snapshotData.nodes as JsonRecord[])
          : [];
        const query = String(plan.query || "")
          .trim()
          .toLowerCase();
        const needles = query
          .split(/\s+/)
          .map((item) => item.trim())
          .filter(Boolean);
        const normalizedNodes = rawNodes.map((node) => {
          const ref = String(node.ref || "");
          return {
            ...node,
            uid: String(node.uid || ref),
            ref,
          };
        });
        const rankedNodes = normalizedNodes.map((node, index) => {
          const ranked = scoreSearchNode(node, needles);
          return {
            node,
            index,
            score: ranked.score,
            matchedNeedles: ranked.matchedNeedles,
          };
        });
        const filteredRanked = needles.length
          ? rankedNodes.filter((item) => item.matchedNeedles > 0)
          : rankedNodes;
        const sortedRanked = needles.length
          ? filteredRanked.sort((a, b) => {
              const aFullMatch = a.matchedNeedles >= needles.length;
              const bFullMatch = b.matchedNeedles >= needles.length;
              if (aFullMatch !== bFullMatch) return bFullMatch ? 1 : -1;
              if (a.score !== b.score) return b.score - a.score;
              return a.index - b.index;
            })
          : filteredRanked;
        const nodes = sortedRanked
          .slice(0, plan.maxResults)
          .map((item) => item.node);
        return buildToolResponseEnvelope(
          "search_elements",
          {
            query: plan.query,
            tabId: plan.tabId,
            count: nodes.length,
            total: sortedRanked.length,
            nodes,
            snapshotId: String(snapshotData.snapshotId || ""),
            url: String(snapshotData.url || ""),
            title: String(snapshotData.title || ""),
          },
          {
            capabilityUsed: out.capabilityUsed || plan.capability,
            modeUsed: out.modeUsed,
            providerId: out.providerId,
            fallbackFrom: out.fallbackFrom,
          },
        );
      }
      case "step.element_action": {
        const out = await executeStep({
          sessionId,
          capability: plan.capability,
          action: "action",
          args: {
            tabId: plan.tabId,
            action: plan.action,
            expect: plan.expect,
          },
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            plan.toolName,
            out,
            `${plan.toolName} 执行失败`,
            "Take a fresh snapshot and retry with updated ref/selector.",
            {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          );
        }
        const providerAction = toRecord(out.data);
        const verified =
          typeof providerAction.verified === "boolean"
            ? providerAction.verified
            : out.verified;
        const verifyReason = String(
          providerAction.verifyReason || out.verifyReason || "",
        );
        const actionData =
          providerAction.data !== undefined ? providerAction.data : out.data;
        const explicitExpect = normalizeVerifyExpect(plan.expect || null);
        const hardFail = !!explicitExpect;
        if (!verified && hardFail) {
          const errorReason = mapVerifyReasonToFailureReason(verifyReason);
          return attachFailureProtocol(
            plan.toolName,
            {
              error: `${plan.toolName} 执行成功但未通过验证`,
              errorCode: "E_VERIFY_FAILED",
              errorReason,
              retryable: true,
              retryHint:
                "Adjust action args/expect and retry the browser action.",
              details: {
                verifyReason,
                data: actionData,
              },
            },
            {
              phase: "verify",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          );
        }
        return buildToolResponseEnvelope(plan.toolName, actionData, {
          capabilityUsed: out.capabilityUsed || plan.capability,
          modeUsed: out.modeUsed,
          providerId: out.providerId,
          fallbackFrom: out.fallbackFrom,
          verifyReason,
          verified,
        });
      }
      case "step.script_action": {
        const out = await callInfra(infra, {
          type: "cdp.execute",
          tabId: plan.tabId,
          action: {
            type: "runtime.evaluate",
            expression: plan.expression,
            returnByValue: true,
          },
        }).catch((error) => {
          const runtimeError = asRuntimeErrorWithMeta(error);
          return {
            error: attachFailureProtocol(
              plan.toolName,
              {
                error: runtimeError.message,
                errorCode:
                  normalizeErrorCode(runtimeError.code) || "E_TOOL_EXECUTE",
                errorReason: "failed_execute",
                retryable: runtimeError.retryable === true,
                retryHint:
                  "Re-observe page state and retry with updated selector/target.",
                details: runtimeError.details,
              },
              { phase: "execute", resumeStrategy: "retry_with_fresh_snapshot" },
            ),
          };
        });
        if (toRecord(out).error) return toRecord(out).error as JsonRecord;
        const resultValue =
          toRecord(toRecord(out).result).value ?? toRecord(out).result ?? out;
        const expect = normalizeVerifyExpect(plan.expect || null);
        if (expect) {
          const verifyOut = await executeStep({
            sessionId,
            capability: CAPABILITIES.browserVerify,
            action: "verify",
            args: {
              tabId: plan.tabId,
              action: {
                expect,
              },
              result: resultValue,
            },
            verifyPolicy: "off",
          });
          if (!verifyOut.ok || verifyOut.verified !== true) {
            return attachFailureProtocol(
              plan.toolName,
              {
                error: `${plan.toolName} 后置验证失败`,
                errorCode:
                  normalizeErrorCode(verifyOut.errorCode) || "E_VERIFY_FAILED",
                errorReason: mapVerifyReasonToFailureReason(
                  verifyOut.verifyReason,
                ),
                retryable: true,
                retryHint: "Refine selector/expect and retry.",
                details: verifyOut.data || verifyOut.errorDetails || null,
              },
              { phase: "verify", resumeStrategy: "retry_with_fresh_snapshot" },
            );
          }
        }
        return buildToolResponseEnvelope(plan.toolName, resultValue, {
          capabilityUsed: plan.capability,
          modeUsed: "cdp",
        });
      }
      case "step.capture_screenshot": {
        if (
          plan.toolName === "capture_screenshot_with_highlight" &&
          plan.selector
        ) {
          const highlightExpression = `(() => {
            const selector = ${JSON.stringify(plan.selector)};
            const nodes = Array.from(document.querySelectorAll(selector));
            if (!nodes.length) return { ok: false, selector };
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              node.setAttribute('data-bbl-capture-highlight', '1');
              node.style.outline = '2px solid #ff6a00';
              node.style.outlineOffset = '2px';
            }
            return { ok: true, count: nodes.length, selector };
          })()`;
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              type: "runtime.evaluate",
              expression: highlightExpression,
              returnByValue: true,
            },
          }).catch(() => undefined);
        }

        const screenshot = await callInfra(infra, {
          type: "cdp.execute",
          tabId: plan.tabId,
          action: {
            domain: "Page",
            method: "captureScreenshot",
            params: {
              format: plan.format,
              ...(plan.quality == null ? {} : { quality: plan.quality }),
            },
          },
        }).catch((error) => {
          const runtimeError = asRuntimeErrorWithMeta(error);
          return {
            error: attachFailureProtocol(
              plan.toolName,
              {
                error: runtimeError.message,
                errorCode:
                  normalizeErrorCode(runtimeError.code) || "E_TOOL_EXECUTE",
                errorReason: "failed_execute",
                retryable: runtimeError.retryable === true,
                retryHint: "Re-check tab focus/state and retry screenshot.",
                details: runtimeError.details,
              },
              { phase: "execute", resumeStrategy: "retry_with_fresh_snapshot" },
            ),
          };
        });

        if (toRecord(screenshot).error)
          return toRecord(screenshot).error as JsonRecord;
        const base64 = String(toRecord(screenshot).data || "");
        if (!base64) {
          return attachFailureProtocol(
            plan.toolName,
            {
              error: "截图结果为空",
              errorCode: "E_TOOL_EXECUTE",
              errorReason: "failed_execute",
              retryable: true,
              retryHint: "Retry capture_screenshot after page settles.",
            },
            { phase: "execute", resumeStrategy: "retry_with_fresh_snapshot" },
          );
        }

        if (
          plan.toolName === "capture_screenshot_with_highlight" &&
          plan.selector
        ) {
          const cleanupExpression = `(() => {
            for (const node of document.querySelectorAll('[data-bbl-capture-highlight=\"1\"]')) {
              if (!(node instanceof HTMLElement)) continue;
              node.style.outline = '';
              node.style.outlineOffset = '';
              node.removeAttribute('data-bbl-capture-highlight');
            }
            return { ok: true };
          })()`;
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              type: "runtime.evaluate",
              expression: cleanupExpression,
              returnByValue: true,
            },
          }).catch(() => undefined);
        }

        const tabInfo = await chrome.tabs.get(plan.tabId).catch(() => null);
        const imageData = `data:image/${plan.format};base64,${base64}`;
        return buildToolResponseEnvelope(plan.toolName, {
          success: true,
          tabId: plan.tabId,
          imageData,
          sendToLLM: plan.sendToLLM,
          selector: plan.selector || undefined,
          url: String(tabInfo?.url || tabInfo?.pendingUrl || ""),
          title: String(tabInfo?.title || ""),
        });
      }
      case "step.download_image": {
        const expression = `(() => {
          const dataUrl = ${JSON.stringify(plan.imageData)};
          const filename = ${JSON.stringify(plan.filename)};
          if (!dataUrl || !String(dataUrl).startsWith('data:image/')) {
            return { success: false, error: 'invalid_image_data' };
          }
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = filename;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
          return { success: true, filename, url: location.href, title: document.title };
        })()`;
        const out = await callInfra(infra, {
          type: "cdp.execute",
          tabId: plan.tabId,
          action: {
            type: "runtime.evaluate",
            expression,
            returnByValue: true,
          },
        });
        return buildToolResponseEnvelope(
          "download_image",
          toRecord(toRecord(out).result).value || out,
        );
      }
      case "step.download_chat_images": {
        const results: Array<JsonRecord> = [];
        for (let i = 0; i < plan.files.length; i += 1) {
          const file = plan.files[i];
          const expression = `(() => {
            const dataUrl = ${JSON.stringify(file.imageData)};
            const filename = ${JSON.stringify(file.filename)};
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = filename;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            a.remove();
            return { success: true, filename };
          })()`;
          const out = await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              type: "runtime.evaluate",
              expression,
              returnByValue: true,
            },
          });
          results.push(toRecord(toRecord(toRecord(out).result).value));
          await delay(60);
        }
        return buildToolResponseEnvelope("download_chat_images", {
          success: true,
          downloaded: results.length,
          results,
        });
      }
      case "step.computer": {
        const action = plan.action;
        if (action === "wait") {
          const waitMs = Math.max(
            0,
            Math.min(60_000, Math.floor((plan.durationSec ?? 1) * 1000)),
          );
          await delay(waitMs);
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            waitedMs: waitMs,
          });
        }
        if (action === "type") {
          const text = String(plan.text || "");
          const expression = `(() => {
            const text = ${JSON.stringify(text)};
            const TYPABLE_SELECTOR = "input,textarea,[contenteditable='true'],[role='textbox'],[role='searchbox'],[role='combobox']";
            const isTypableElement = (el) => {
              if (!el || el.nodeType !== 1) return false;
              if ('disabled' in el && !!el.disabled) return false;
              if ('readOnly' in el && !!el.readOnly) return false;
              if ('value' in el) return true;
              if (el.isContentEditable) return true;
              const role = String(el.getAttribute?.('role') || '').trim().toLowerCase();
              return role === 'textbox' || role === 'searchbox' || role === 'combobox';
            };
            const findTypableNear = (origin) => {
              if (!origin || origin.nodeType !== 1) return null;
              const resolveByIdAttr = (attrValue) => {
                const id = String(attrValue || '').trim();
                if (!id) return null;
                const found = document.getElementById(id);
                return isTypableElement(found) ? found : null;
              };
              const byAriaControls = resolveByIdAttr(origin.getAttribute?.('aria-controls'));
              if (byAriaControls) return byAriaControls;
              const byFor = resolveByIdAttr(origin.getAttribute?.('for'));
              if (byFor) return byFor;
              const directDesc = origin.querySelector?.(TYPABLE_SELECTOR);
              if (isTypableElement(directDesc)) return directDesc;
              const labelDesc = origin.closest?.('label')?.querySelector?.(TYPABLE_SELECTOR);
              if (isTypableElement(labelDesc)) return labelDesc;
              let cur = origin;
              for (let i = 0; i < 3 && cur; i += 1) {
                const inParent = cur.parentElement?.querySelector?.(TYPABLE_SELECTOR);
                if (isTypableElement(inParent)) return inParent;
                cur = cur.parentElement;
              }
              return null;
            };
            const syncReactValueTracker = (target, previousValue) => {
              try {
                const tracker = target?._valueTracker;
                if (tracker && typeof tracker.setValue === 'function') {
                  tracker.setValue(String(previousValue ?? ''));
                }
              } catch {
                // ignore react tracker mismatch
              }
            };
            const dispatchInputLikeEvents = (target, nextText, mode = 'type') => {
              try {
                target.dispatchEvent(new InputEvent('beforeinput', {
                  bubbles: true,
                  cancelable: true,
                  data: nextText,
                  inputType: 'insertText'
                }));
              } catch {
                // ignore unsupported InputEvent ctor
              }
              let sent = false;
              try {
                target.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  data: nextText,
                  inputType: 'insertText'
                }));
                sent = true;
              } catch {
                // fallback below
              }
              if (!sent) target.dispatchEvent(new Event('input', { bubbles: true }));
              if (mode === 'fill' || mode === 'type') target.dispatchEvent(new Event('change', { bubbles: true }));
              target.dispatchEvent(new Event('keyup', { bubbles: true }));
            };
            let target = document.activeElement || document.body;
            if (!target) return { success: false, error: 'no_active_element' };
            if (!isTypableElement(target)) {
              const fallback = findTypableNear(target);
              if (fallback) target = fallback;
            }
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              const previousValue = String(target.value ?? '');
              let setter = null;
              try {
                const proto = Object.getPrototypeOf(target);
                setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                  || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                  || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
                  || null;
              } catch {
                setter = null;
              }
              if (setter) setter.call(target, text);
              else target.value = text;
              syncReactValueTracker(target, previousValue);
              dispatchInputLikeEvents(target, text, 'type');
              return { success: true, action: 'type', typed: text.length, via: 'value-setter' };
            }
            const role = String(target.getAttribute?.('role') || '').trim().toLowerCase();
            if (target.isContentEditable || role === 'textbox' || role === 'searchbox' || role === 'combobox') {
              let usedInsertText = false;
              try {
                if (typeof document.execCommand === 'function') {
                  try { document.execCommand('selectAll', false); } catch {}
                  usedInsertText = document.execCommand('insertText', false, text) === true;
                }
              } catch {
                usedInsertText = false;
              }
              if (!usedInsertText) target.textContent = text;
              dispatchInputLikeEvents(target, text, 'type');
              return {
                success: true,
                action: 'type',
                typed: text.length,
                via: usedInsertText ? 'contenteditable-inserttext' : 'contenteditable-textContent'
              };
            }
            return { success: false, error: 'active_element_not_typable' };
          })()`;
          const out = await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              type: "runtime.evaluate",
              expression,
              returnByValue: true,
            },
          });
          const result = toRecord(toRecord(out).result).value || out;
          const payload = toRecord(result);
          const success = payload.success === true || payload.ok === true;
          if (!success) {
            return attachFailureProtocol(
              "computer",
              {
                error: String(payload.error || "computer(type) 执行失败"),
                errorCode: "E_TOOL_EXECUTE",
                errorReason: "failed_execute",
                retryable: true,
                retryHint:
                  "Focus an editable target (input/textarea/contenteditable) and retry computer(type).",
                details: payload,
              },
              {
                phase: "execute",
                category: "missing_target",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            );
          }
          return buildToolResponseEnvelope("computer", result);
        }
        if (action === "key") {
          const keys = String(plan.text || "")
            .split(/\\s+/)
            .map((item) => item.trim())
            .filter(Boolean);
          if (!keys.length) {
            return attachFailureProtocol(
              "computer",
              {
                error: "computer(key) 需要 text",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide text key sequence and retry computer.",
              },
              { phase: "execute", resumeStrategy: "replan" },
            );
          }
          for (const key of keys) {
            await executeStep({
              sessionId,
              capability: CAPABILITIES.browserAction,
              action: "action",
              args: {
                tabId: plan.tabId,
                action: {
                  kind: "press",
                  key,
                },
              },
              verifyPolicy: "off",
            });
          }
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            keys,
          });
        }
        if (action === "scroll_to") {
          const target = plan.uid || plan.selector;
          if (!target) {
            return attachFailureProtocol(
              "computer",
              {
                error: "computer(scroll_to) 需要 uid 或 selector",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide uid/selector and retry computer scroll_to.",
              },
              { phase: "execute", resumeStrategy: "replan" },
            );
          }
          const out = await executeStep({
            sessionId,
            capability: CAPABILITIES.browserAction,
            action: "action",
            args: {
              tabId: plan.tabId,
              action: {
                kind: "hover",
                uid: plan.uid || undefined,
                ref: plan.uid || undefined,
                selector: plan.selector || undefined,
              },
            },
            verifyPolicy: "off",
          });
          if (!out.ok) {
            return buildStepFailureEnvelope(
              "computer",
              out,
              "computer scroll_to 失败",
              "Refresh target and retry computer scroll_to.",
              {
                defaultRetryable: true,
                phase: "execute",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            );
          }
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            target,
          });
        }
        const coordinate = plan.coordinate;
        const startCoordinate = plan.startCoordinate;
        if (!coordinate && action !== "scroll") {
          return attachFailureProtocol(
            "computer",
            {
              error: `computer(${action}) 需要 coordinate`,
              errorCode: "E_ARGS",
              errorReason: "failed_execute",
              retryable: false,
              retryHint: "Provide coordinate and retry computer.",
            },
            { phase: "execute", resumeStrategy: "replan" },
          );
        }
        const [x, y] = coordinate || [0, 0];
        const clickCount =
          action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        const button = action === "right_click" ? "right" : "left";
        const dispatchMouse = async (type: string, params: JsonRecord = {}) =>
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              domain: "Input",
              method: "dispatchMouseEvent",
              params: {
                type,
                x,
                y,
                button,
                clickCount,
                ...params,
              },
            },
          });
        if (
          action === "hover" ||
          action === "left_click" ||
          action === "right_click" ||
          action === "double_click" ||
          action === "triple_click"
        ) {
          await dispatchMouse("mouseMoved");
          if (action !== "hover") {
            await dispatchMouse("mousePressed");
            await dispatchMouse("mouseReleased");
          }
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            coordinate: [x, y],
          });
        }
        if (action === "left_click_drag") {
          if (!startCoordinate || !coordinate) {
            return attachFailureProtocol(
              "computer",
              {
                error:
                  "computer(left_click_drag) 需要 start_coordinate 和 coordinate",
                errorCode: "E_ARGS",
                errorReason: "failed_execute",
                retryable: false,
                retryHint: "Provide both start_coordinate and coordinate.",
              },
              { phase: "execute", resumeStrategy: "replan" },
            );
          }
          const [sx, sy] = startCoordinate;
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              domain: "Input",
              method: "dispatchMouseEvent",
              params: { type: "mouseMoved", x: sx, y: sy, button: "left" },
            },
          });
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              domain: "Input",
              method: "dispatchMouseEvent",
              params: {
                type: "mousePressed",
                x: sx,
                y: sy,
                button: "left",
                clickCount: 1,
              },
            },
          });
          await dispatchMouse("mouseMoved", { buttons: 1 });
          await dispatchMouse("mouseReleased", { clickCount: 1 });
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            start_coordinate: [sx, sy],
            coordinate: [x, y],
          });
        }
        if (action === "scroll") {
          const amount = Number.isFinite(Number(plan.scrollAmount))
            ? Number(plan.scrollAmount)
            : 1000;
          const direction = plan.scrollDirection || "down";
          const deltaX =
            direction === "left" ? -amount : direction === "right" ? amount : 0;
          const deltaY =
            direction === "up" ? -amount : direction === "down" ? amount : 0;
          await callInfra(infra, {
            type: "cdp.execute",
            tabId: plan.tabId,
            action: {
              domain: "Input",
              method: "dispatchMouseEvent",
              params: {
                type: "mouseWheel",
                x: x || 0,
                y: y || 0,
                deltaX,
                deltaY,
              },
            },
          });
          return buildToolResponseEnvelope("computer", {
            success: true,
            action,
            deltaX,
            deltaY,
          });
        }
        return attachFailureProtocol(
          "computer",
          {
            error: `computer 不支持 action: ${action}`,
            errorCode: "E_ARGS",
            errorReason: "failed_execute",
            retryable: false,
            retryHint: "Use supported computer action and retry.",
          },
          { phase: "execute", resumeStrategy: "replan" },
        );
      }
      case "step.fill_form": {
        const itemResults: JsonRecord[] = [];
        for (let i = 0; i < plan.elements.length; i += 1) {
          const item = plan.elements[i];
          const out = await executeStep({
            sessionId,
            capability: plan.capability,
            action: "action",
            args: {
              tabId: plan.tabId,
              action: {
                kind: "fill",
                uid: item.uid || undefined,
                ref: item.ref || item.uid || undefined,
                selector: item.selector || undefined,
                backendNodeId: item.backendNodeId || undefined,
                value: item.value,
              },
            },
          });
          if (!out.ok) {
            return attachFailureProtocol(
              "fill_form",
              {
                error: `fill_form 第 ${i + 1} 项填写失败`,
                errorCode: normalizeErrorCode(out.errorCode) || undefined,
                errorReason: "failed_execute",
                retryable: out.retryable === true,
                retryHint:
                  "Refresh elements with search_elements and retry fill_form.",
                details: {
                  index: i,
                  item,
                  error: out.error || "",
                  errorCode: out.errorCode || "",
                  errorDetails: out.errorDetails || null,
                },
              },
              {
                phase: "execute",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            );
          }
          const payload = toRecord(out.data);
          itemResults.push({
            index: i,
            uid: item.uid || item.ref || "",
            ok: true,
            result: payload.data !== undefined ? payload.data : out.data,
          });
        }

        if (plan.submit && Object.keys(plan.submit).length > 0) {
          const submitKind =
            String(plan.submit.kind || "")
              .trim()
              .toLowerCase() || "click";
          const submitOut = await executeStep({
            sessionId,
            capability: plan.capability,
            action: "action",
            args: {
              tabId: plan.tabId,
              action: {
                kind: submitKind,
                uid: String(plan.submit.uid || "").trim() || undefined,
                ref: String(plan.submit.ref || "").trim() || undefined,
                selector:
                  String(plan.submit.selector || "").trim() || undefined,
                key: String(plan.submit.key || "").trim() || undefined,
              },
            },
          });
          if (!submitOut.ok) {
            return attachFailureProtocol(
              "fill_form",
              {
                error: "fill_form 提交动作失败",
                errorCode: normalizeErrorCode(submitOut.errorCode) || undefined,
                errorReason: "failed_execute",
                retryable: submitOut.retryable === true,
                retryHint: "Retry submit action after refreshing element refs.",
                details: {
                  submit: plan.submit,
                  error: submitOut.error || "",
                  errorCode: submitOut.errorCode || "",
                },
              },
              {
                phase: "execute",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            );
          }
          itemResults.push({
            index: itemResults.length,
            submit: true,
            ok: true,
            result: submitOut.data,
          });
        }

        if (Object.keys(plan.expect || {}).length > 0) {
          const verifyOut = await executeStep({
            sessionId,
            capability: CAPABILITIES.browserVerify,
            action: "verify",
            args: {
              tabId: plan.tabId,
              action: {
                expect: plan.expect,
              },
            },
            verifyPolicy: "off",
          });
          if (!verifyOut.ok || verifyOut.verified !== true) {
            return attachFailureProtocol(
              "fill_form",
              {
                error: "fill_form 后置验证失败",
                errorCode:
                  normalizeErrorCode(verifyOut.errorCode) || "E_VERIFY_FAILED",
                errorReason: mapVerifyReasonToFailureReason(
                  verifyOut.verifyReason,
                ),
                retryable: true,
                retryHint:
                  "Refresh page state and retry fill_form with updated refs.",
                details: {
                  expect: plan.expect,
                  verifyReason: verifyOut.verifyReason || "",
                  verifyError: verifyOut.error || "",
                },
              },
              {
                phase: "verify",
                resumeStrategy: "retry_with_fresh_snapshot",
              },
            );
          }
        }

        return buildToolResponseEnvelope(
          "fill_form",
          {
            tabId: plan.tabId,
            filled: plan.elements.length,
            results: itemResults,
          },
          {
            capabilityUsed: plan.capability,
            modeUsed: "cdp",
          },
        );
      }
      case "step.browser_verify": {
        const out = await executeStep({
          sessionId,
          capability: plan.capability,
          action: "verify",
          args: {
            tabId: plan.tabId,
            action: {
              expect: plan.verifyExpect,
            },
          },
          verifyPolicy: "off",
        });
        if (!out.ok) {
          return buildStepFailureEnvelope(
            "browser_verify",
            out,
            "browser_verify 执行失败",
            "Update verify expectation and run browser_verify again.",
            {
              defaultRetryable: true,
              phase: "execute",
              resumeStrategy: "retry_with_fresh_snapshot",
            },
          );
        }
        const providerVerify = toRecord(out.data);
        const verified =
          typeof providerVerify.verified === "boolean"
            ? providerVerify.verified
            : out.verified;
        const verifyData =
          providerVerify.data !== undefined ? providerVerify.data : out.data;
        if (!verified) {
          return attachFailureProtocol(
            "browser_verify",
            {
              error: "browser_verify 未通过",
              errorCode: "E_VERIFY_FAILED",
              errorReason: mapVerifyReasonToFailureReason(out.verifyReason),
              retryable: true,
              retryHint: "Refine expect conditions and re-run browser_verify.",
              details: verifyData,
            },
            {
              phase: "verify",
              resumeStrategy: "replan",
            },
          );
        }
        return buildToolResponseEnvelope("cdp", verifyData, {
          capabilityUsed: out.capabilityUsed || plan.capability,
          modeUsed: out.modeUsed,
          providerId: out.providerId,
          fallbackFrom: out.fallbackFrom,
        });
      }
      default:
        return { error: "未知工具执行计划", errorCode: "E_TOOL_PLAN" };
    }
  }

  function getToolPlanTabId(plan: ToolPlan): number | null {
    if (
      plan.kind === "step.search_elements" ||
      plan.kind === "step.element_action" ||
      plan.kind === "step.script_action" ||
      plan.kind === "step.capture_screenshot" ||
      plan.kind === "step.download_image" ||
      plan.kind === "step.download_chat_images" ||
      plan.kind === "step.computer" ||
      plan.kind === "step.fill_form" ||
      plan.kind === "step.browser_verify"
    ) {
      return Number.isInteger(plan.tabId) ? Number(plan.tabId) : null;
    }
    return null;
  }

  function mergeStepRef(result: JsonRecord, stepRef: JsonRecord): JsonRecord {
    const existing = toRecord(result.stepRef);
    if (Object.keys(existing).length > 0) {
      return {
        ...result,
        stepRef: {
          ...stepRef,
          ...existing,
        },
      };
    }
    return {
      ...result,
      stepRef,
    };
  }

  async function executeToolCall(
    sessionId: string,
    toolCall: ToolCallItem,
  ): Promise<JsonRecord> {
    const requestedTool = String(toolCall.function.name || "").trim();
    const baseStepRef: JsonRecord = {
      toolCallId: String(toolCall.id || ""),
      requestedTool: requestedTool || "unknown",
      argsSignature: normalizeToolArgsForSignature(
        toolCall.function.arguments || "",
      ),
    };

    const resolved = resolveToolCallContext(toolCall);
    if (!resolved.ok) {
      return mergeStepRef(resolved.error, {
        ...baseStepRef,
        stage: "resolve",
      });
    }

    const resolvedStepRef: JsonRecord = {
      ...baseStepRef,
      resolvedTool: resolved.value.resolvedTool,
      executionTool: resolved.value.executionTool,
    };

    const planResult = await buildToolPlan(sessionId, resolved.value);
    if (!planResult.ok) {
      return mergeStepRef(planResult.error, {
        ...resolvedStepRef,
        stage: "plan",
      });
    }

    const tabId = getToolPlanTabId(planResult.plan);
    const planStepRef: JsonRecord = {
      ...resolvedStepRef,
      stage: "dispatch",
      planKind: planResult.plan.kind,
    };
    if (tabId) planStepRef.tabId = tabId;

    const dispatched = await dispatchToolPlan(sessionId, planResult.plan);
    return mergeStepRef(dispatched, planStepRef);
  }


  return { buildToolPlan, dispatchToolPlan, executeToolCall, getToolPlanTabId, mergeStepRef };
}
