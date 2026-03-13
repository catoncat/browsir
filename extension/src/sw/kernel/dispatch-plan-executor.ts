/**
 * Tool plan execution (dispatchToolPlan).
 * Extracted from loop-tool-dispatch.ts to reduce file size.
 */
import {
  toRecord,
  safeStringify,
  normalizeErrorCode,
  asRuntimeErrorWithMeta,
  delay,
  callInfra,
  attachFailureProtocol,
  extractBashExecOutcome,
  buildBashExitFailureEnvelope,
  buildSkillScriptSandboxFailureEnvelope,
  buildStepFailureEnvelope,
  normalizeVerifyExpect,
  scoreSearchNode,
  isRetryableToolErrorCode,
  shouldAutoReplayToolCall,
  computeToolRetryDelayMs,
  buildToolRetryHint,
  queryAllTabsForRuntime,
  getActiveTabIdForRuntime,
  CAPABILITIES,
  type RuntimeErrorWithMeta,
  type FailureReason,
} from "./runtime-loop.browser";
import {
  buildToolResponseEnvelope,
  mapVerifyReasonToFailureReason,
  createRuntimeError,
  extractSkillReadContent,
  buildSkillChildLocation,
  buildSkillPackageRootLocation,
  BASH_RUNTIME_TOOL_NAMES,
  TOOL_AUTO_RETRY_MAX,
  type ToolPlan,
  type ToolDispatchDeps,
} from "./loop-tool-dispatch";
import type { SkillMetadata } from "./skill-registry";
import { isVirtualUri } from "./virtual-fs.browser";
import { normalizeSkillCreateRequest } from "./skill-create";
import { nowIso, type JsonRecord } from "./types";
import { writeSessionMeta } from "./session-store.browser";
import type {
  ExecuteCapability,
  ExecuteMode,
  ExecuteStepResult,
} from "./orchestrator.browser";

export function createDispatchExecutor(deps: ToolDispatchDeps) {
  const { orchestrator, infra, executeStep } = deps;

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


  function shellQuote(input: string): string {
    return `'${String(input || "").replace(/'/g, "'\"'\"'")}'`;
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


  return { dispatchToolPlan };
}
