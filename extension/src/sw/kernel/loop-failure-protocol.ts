/**
 * Failure classification, retry strategy, and protocol attachment.
 * Extracted from runtime-loop.browser.ts to reduce file size.
 */
import type {
  FailureReason,
  ToolRetryAction,
  BashExecOutcome,
  RuntimeErrorWithMeta,
} from "./loop-shared-types";
import {
  CANONICAL_BROWSER_TOOL_NAMES,
  TOOL_AUTO_RETRY_BASE_DELAY_MS,
  TOOL_AUTO_RETRY_CAP_DELAY_MS,
  normalizeFailureReasonValue,
} from "./loop-shared-types";
import {
  normalizeErrorCode,
  safeStringify,
  clipText,
  toRecord,
} from "./loop-shared-utils";
import type { ExecuteStepResult } from "./orchestrator.browser";
import type { JsonRecord } from "./types";

// ── Side-effect classification ──────────────────────────────────────

function isSideEffectingToolName(toolName: string): boolean {
  const normalized = String(toolName || "")
    .trim()
    .toLowerCase();
  return [
    "host_write_file",
    "browser_write_file",
    "host_edit_file",
    "browser_edit_file",
    "create_new_tab",
    "close_tab",
    "ungroup_tabs",
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
    "computer",
    "download_image",
    "download_chat_images",
    "request_intervention",
    "cancel_intervention",
    "create_skill",
    "execute_skill_script",
  ].includes(normalized);
}

// ── Tool retry decision ─────────────────────────────────────────────

function classifyToolRetryDecision(
  toolName: string,
  errorCode: string,
): {
  action: ToolRetryAction;
  retryable: boolean;
  retryHint: string;
} {
  const normalizedCode = normalizeErrorCode(errorCode);
  const sideEffecting = isSideEffectingToolName(toolName);

  if (normalizedCode === "E_BUSY") {
    return {
      action: "auto_replay",
      retryable: true,
      retryHint: "Bridge is busy, retry after a short delay.",
    };
  }

  if (normalizedCode === "E_BRIDGE_DISCONNECTED") {
    return {
      action: "auto_replay",
      retryable: true,
      retryHint: "Bridge connection was unstable; retry this tool call.",
    };
  }

  if (normalizedCode === "E_TIMEOUT") {
    return {
      action: "llm_replan",
      retryable: true,
      retryHint: ["host_bash", "browser_bash"].includes(
        String(toolName || "")
          .trim()
          .toLowerCase(),
      )
        ? "Increase timeoutMs and retry the same goal."
        : "Operation timed out; adjust parameters and retry the same goal.",
    };
  }

  if (normalizedCode === "E_CLIENT_TIMEOUT") {
    if (sideEffecting) {
      return {
        action: "llm_replan",
        retryable: true,
        retryHint:
          "Client timed out. Re-evaluate state with a fresh read/snapshot before retrying side effects.",
      };
    }
    return {
      action: "auto_replay",
      retryable: true,
      retryHint:
        "Client timed out before receiving result; retry the same call.",
    };
  }

  if (
    normalizedCode === "E_NO_TAB" ||
    normalizedCode === "E_REF_REQUIRED" ||
    normalizedCode === "E_VERIFY_FAILED"
  ) {
    return {
      action: "llm_replan",
      retryable: true,
      retryHint:
        "Refresh context (get_all_tabs/search_elements) and retry with updated target.",
    };
  }

  return {
    action: "fail_fast",
    retryable: false,
    retryHint: "Retry only when the failure is transient.",
  };
}

export function isRetryableToolErrorCode(toolName: string, code: string): boolean {
  return classifyToolRetryDecision(toolName, code).retryable;
}

export function shouldAutoReplayToolCall(toolName: string, code: string): boolean {
  return classifyToolRetryDecision(toolName, code).action === "auto_replay";
}

export function computeToolRetryDelayMs(attempt: number): number {
  const next = TOOL_AUTO_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(TOOL_AUTO_RETRY_CAP_DELAY_MS, next);
}

export function buildToolRetryHint(toolName: string, errorCode: string): string {
  return classifyToolRetryDecision(toolName, errorCode).retryHint;
}

// ── Failure reason / phase / category inference ─────────────────────

export function normalizeFailureReason(raw: unknown): FailureReason {
  return normalizeFailureReasonValue(raw);
}

function isBrowserToolName(toolName: string): boolean {
  return CANONICAL_BROWSER_TOOL_NAMES.includes(
    String(toolName || "")
      .trim()
      .toLowerCase() as (typeof CANONICAL_BROWSER_TOOL_NAMES)[number],
  );
}

function inferModeEscalationDirective(input: {
  toolName: string;
  errorCode: string;
  errorText: string;
  retryHint: string;
  details: unknown;
  errorReason: FailureReason;
}): JsonRecord | null {
  if (!isBrowserToolName(input.toolName)) return null;

  const errorCode = normalizeErrorCode(input.errorCode);
  const combined = [
    String(input.errorText || ""),
    String(input.retryHint || ""),
    safeStringify(input.details || null, 600),
  ]
    .join(" ")
    .toLowerCase();
  const browserWriteFailureFallback =
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
      "computer",
      "browser_verify",
    ].includes(
      String(input.toolName || "")
        .trim()
        .toLowerCase(),
    ) &&
    (input.errorReason === "failed_execute" ||
      input.errorReason === "failed_verify");
  const hasFocusSignal =
    errorCode === "E_VERIFY_FAILED" ||
    errorCode.startsWith("E_CDP_") ||
    /focus|foreground|background|active tab|user.?gesture|lease|后台/.test(
      combined,
    ) ||
    browserWriteFailureFallback;
  if (!hasFocusSignal) return null;

  return {
    suggested: true,
    from: "background",
    to: "focus",
    trigger:
      input.errorReason === "failed_verify"
        ? "verify_unstable"
        : "focus_required",
    prompt:
      "当前步骤疑似受后台执行限制。请切换到 focus 模式并续跑当前 step（无需重开会话）。",
    errorCode: errorCode || undefined,
  };
}

// ── Failure protocol attachment ─────────────────────────────────────

export function attachFailureProtocol(
  toolName: string,
  payload: JsonRecord,
  options: {
    defaultRetryable?: boolean;
    errorReason?: FailureReason;
    modeEscalation?: JsonRecord | null;
    stepRef?: JsonRecord | null;
  } = {},
): JsonRecord {
  const normalizedToolName = String(toolName || "")
    .trim()
    .toLowerCase();
  const errorCode = normalizeErrorCode(payload.errorCode);
  const errorReason = normalizeFailureReason(
    options.errorReason || payload.errorReason,
  );
  const retryDecision = classifyToolRetryDecision(
    normalizedToolName,
    errorCode,
  );
  const defaultRetryable = options.defaultRetryable === true;
  const retryable =
    payload.retryable === true || defaultRetryable || retryDecision.retryable;
  const retryHintBase = String(
    payload.retryHint || buildToolRetryHint(normalizedToolName, errorCode),
  );
  const modeEscalation =
    options.modeEscalation !== undefined
      ? options.modeEscalation
      : inferModeEscalationDirective({
          toolName: normalizedToolName,
          errorCode,
          errorText: String(payload.error || ""),
          retryHint: retryHintBase,
          details: payload.details || payload.errorDetails || null,
          errorReason,
        });
  let retryHint = retryHintBase;
  if (
    modeEscalation &&
    !/focus|foreground|前台/.test(retryHint.toLowerCase())
  ) {
    retryHint = `${retryHint} Switch to focus mode and resume the current step without restarting the session.`;
  }

  const out: JsonRecord = {
    ...payload,
    errorCode: errorCode || undefined,
    errorReason,
    retryable,
    retryHint,
  };
  if (modeEscalation) out.modeEscalation = modeEscalation;
  return out;
}

// ── Bash failure envelopes ──────────────────────────────────────────

function extractBashCommandFromArgv(argv: string[]): string {
  if (!Array.isArray(argv) || argv.length === 0) return "";
  const shellEvalIndex = argv.findIndex((value) => value === "-lc");
  if (shellEvalIndex >= 0 && shellEvalIndex + 1 < argv.length) {
    return String(argv[shellEvalIndex + 1] || "");
  }
  return String(argv[argv.length - 1] || "");
}

function diagnoseBashExitFailure(input: {
  toolName: string;
  exitCode: number;
  stderr: string;
}): { tag: string; error: string; retryHint: string } {
  const normalizedTool = String(input.toolName || "")
    .trim()
    .toLowerCase();
  const stderrLower = String(input.stderr || "").toLowerCase();
  if (
    normalizedTool === "browser_bash" &&
    /(?:\bwindow is not defined\b|\bdocument is not defined\b)/i.test(
      stderrLower,
    )
  ) {
    return {
      tag: "dom_global_unavailable",
      error: `browser_bash 执行失败：sandbox shell 不是页面 DOM 上下文，window/document 不可用（exitCode=${input.exitCode}）。`,
      retryHint:
        "需要页面 DOM 时改用 browser.action/browser_verify/script_action；仅执行命令时请移除 window/document 后重试。",
    };
  }
  if (
    normalizedTool === "browser_bash" &&
    /expected word but got lparen/i.test(stderrLower)
  ) {
    return {
      tag: "unsupported_shell_syntax",
      error: `browser_bash 执行失败：sandbox shell 不支持 C-style for ((...)) 语法（exitCode=${input.exitCode}）。`,
      retryHint:
        "改用 POSIX 写法（for i in ...; do ...; done），或切换 host_bash 使用宿主 bash。",
    };
  }
  const stderrLine = clipText(
    String(input.stderr || "")
      .split(/\r?\n/)
      .find((line) => String(line || "").trim().length > 0) || "",
    240,
  );
  return {
    tag: "non_zero_exit",
    error: stderrLine
      ? `${input.toolName} 执行失败：bash.exec exitCode=${input.exitCode}，stderr=${stderrLine}`
      : `${input.toolName} 执行失败：bash.exec exitCode=${input.exitCode}`,
    retryHint:
      "检查命令与运行时兼容性后重试；browser_bash 使用 sandbox shell，语法与宿主 bash 可能不同。",
  };
}

export function extractBashExecOutcome(data: unknown): BashExecOutcome | null {
  const root = toRecord(data);
  const rootData = toRecord(root.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates = [
    root,
    rootData,
    rootResponse,
    rootResponseData,
    rootResponseInnerData,
    rootResult,
  ];
  for (const item of candidates) {
    const cmdId = String(item.cmdId || "").trim();
    const hasCmd = cmdId === "bash.exec";
    const hasFields =
      item.exitCode !== undefined ||
      typeof item.stdout === "string" ||
      typeof item.stderr === "string";
    if (!hasCmd && !hasFields) continue;
    const argv = Array.isArray(item.argv)
      ? item.argv.map((value) => String(value || ""))
      : [];
    const exitCodeRaw = Number(item.exitCode);
    return {
      cmdId: hasCmd ? cmdId : "bash.exec",
      argv,
      stdout: typeof item.stdout === "string" ? item.stdout : "",
      stderr: typeof item.stderr === "string" ? item.stderr : "",
      exitCode: Number.isFinite(exitCodeRaw) ? exitCodeRaw : null,
    };
  }
  return null;
}

export function buildBashExitFailureEnvelope(
  toolName: string,
  invoke: ExecuteStepResult,
  outcome: BashExecOutcome,
): JsonRecord {
  const exitCode = Number(outcome.exitCode);
  const diagnosed = diagnoseBashExitFailure({
    toolName,
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    stderr: outcome.stderr,
  });
  return {
    ...attachFailureProtocol(
      toolName,
      {
        error: diagnosed.error,
        errorCode: "E_BASH_EXIT_NON_ZERO",
        errorReason: "failed_execute",
        retryable: true,
        retryHint: diagnosed.retryHint,
        details: {
          cmdId: outcome.cmdId,
          exitCode: outcome.exitCode,
          command: clipText(extractBashCommandFromArgv(outcome.argv), 1_200),
          stdout: clipText(outcome.stdout, 1_200),
          stderr: clipText(outcome.stderr, 1_200),
          diagnosis: diagnosed.tag,
        },
      },
    ),
    modeUsed: invoke.modeUsed,
    providerId: invoke.providerId || undefined,
    fallbackFrom: invoke.fallbackFrom || undefined,
  };
}

export function buildSkillScriptSandboxFailureEnvelope(input: {
  invoke: ExecuteStepResult;
  outcome: BashExecOutcome;
  location: string;
  scriptPath: string;
  command: string;
  cwd?: string;
}): JsonRecord {
  const stderrLine = clipText(
    String(input.outcome.stderr || "")
      .split(/\r?\n/)
      .find((line) => String(line || "").trim().length > 0) || "",
    240,
  );
  const missingRuntime =
    /^([a-zA-Z0-9._+-]+):\s*(?:command not found|not found)\b/i.exec(
      stderrLine,
    )?.[1] || "";

  if (missingRuntime) {
    return {
      ...attachFailureProtocol(
        "execute_skill_script",
        {
          error: `当前 browser runtime 不支持技能脚本解释器: ${missingRuntime}`,
          errorCode: "E_TOOL_UNSUPPORTED",
          errorReason: "failed_execute",
          retryable: false,
          retryHint:
            "为 browser sandbox 提供对应解释器，或改用现有内置工具/host 工具完成同等动作。",
          details: {
            location: input.location,
            scriptPath: input.scriptPath,
            cwd: input.cwd || null,
            command: clipText(input.command, 1_200),
            exitCode: input.outcome.exitCode,
            stdout: clipText(input.outcome.stdout, 1_200),
            stderr: clipText(input.outcome.stderr, 1_200),
            missingRuntime,
          },
        },
      ),
      modeUsed: input.invoke.modeUsed,
      providerId: input.invoke.providerId || undefined,
      fallbackFrom: input.invoke.fallbackFrom || undefined,
    };
  }

  return buildBashExitFailureEnvelope(
    "execute_skill_script",
    input.invoke,
    input.outcome,
  );
}

export function buildStepFailureEnvelope(
  toolName: string,
  out: ExecuteStepResult,
  fallbackError: string,
  retryHint: string,
  options: {
    defaultRetryable?: boolean;
    errorReason?: FailureReason;
    modeEscalation?: JsonRecord | null;
    stepRef?: JsonRecord | null;
  } = {},
): JsonRecord {
  const base = attachFailureProtocol(
    toolName,
    {
      error: out.error || fallbackError,
      errorCode: normalizeErrorCode(out.errorCode) || undefined,
      errorReason: options.errorReason || "failed_execute",
      retryable: out.retryable === true,
      retryHint,
      details: out.errorDetails || null,
    },
    options,
  );
  return {
    ...base,
    modeUsed: out.modeUsed,
    providerId: out.providerId || undefined,
    fallbackFrom: out.fallbackFrom || undefined,
  };
}
