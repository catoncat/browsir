/**
 * Tool dispatch: plan building, dispatching, and execution.
 * Extracted from runtime-loop.browser.ts to reduce file size.
 */
import { createDispatchExecutor } from "./dispatch-plan-executor";
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
  inferSearchElementsFilter,
  normalizeVerifyExpect,
  scoreSearchNode,
  readContractExecution,
  sanitizeLlmToolDefinitionForProvider,
  normalizeToolArgsForSignature,
  normalizeSchemaRequiredList,
  readTopLevelConstraintRequiredSets,
  queryAllTabsForRuntime,
  getActiveTabIdForRuntime,
  extractLlmConfig,
  readSharedTabIds,
} from "./loop-shared-utils";
import {
  attachFailureProtocol,
  extractBashExecOutcome,
  buildBashExitFailureEnvelope,
  buildSkillScriptSandboxFailureEnvelope,
  buildStepFailureEnvelope,
  isRetryableToolErrorCode,
  shouldAutoReplayToolCall,
  computeToolRetryDelayMs,
  buildToolRetryHint,
} from "./loop-failure-protocol";
import {
  CAPABILITIES,
  RUNTIME_EXECUTABLE_TOOL_NAMES,
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  type RuntimeErrorWithMeta,
  type ToolCallItem,
  type FailureReason,
} from "./loop-shared-types";
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

export type ToolPlan =
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
  const { dispatchToolPlan } = createDispatchExecutor(deps);

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

  // --- Tool dispatch helpers ---

  function normalizeInterventionType(raw: unknown): string {
    const type = String(raw || "")
      .trim()
      .toLowerCase();
    if (!type) return "";
    return type;
  }

  // buildSkillChildLocation and buildSkillPackageRootLocation are at module scope

  function normalizeDownloadFilename(input: string, fallback: string): string {
    const name = String(input || "").trim();
    const base = (name || fallback)
      .replace(/[\\/:*?\"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    return base || fallback;
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
