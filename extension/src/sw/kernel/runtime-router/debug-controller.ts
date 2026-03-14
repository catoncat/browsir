import type { BrainOrchestrator } from "../orchestrator.browser";
import type { RuntimeInfraHandler } from "../runtime-infra.browser";
import type { RuntimeLoopController } from "../runtime-loop.browser";
import { getLifoDiagnostics } from "../browser-unix-runtime/lifo-adapter";
import { readPersistedPluginRecords } from "./plugin-persistence";
import { readUiExtensionDescriptors } from "./plugin-ui-extensions";
import { getRuntimeDebugSnapshot } from "./runtime-debug-store";
import { buildConversationView } from "./session-utils";
import { clampStepStream } from "./step-stream-utils";

type RuntimeOk<T = unknown> = { ok: true; data: T };
type RuntimeErr = { ok: false; error: string };
type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;
type JsonRecord = Record<string, unknown>;

function ok<T>(data: T): RuntimeOk<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeErr {
  return { ok: false, error };
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object"
    ? (value as JsonRecord)
    : {};
}

function clipText(value: unknown, max = 240): string {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function queryPanelUiState(): Promise<JsonRecord | null> {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "bbloop.ui.state.query",
    });
    if (resp && resp.ok) return resp.data as JsonRecord;
  } catch {
    // SidePanel may not be open — ignore
  }
  return null;
}

async function buildPluginSnapshot(
  orchestrator: BrainOrchestrator,
  pluginId?: string,
): Promise<JsonRecord> {
  const targetPluginId = String(pluginId || "").trim();
  const plugins = orchestrator
    .listPlugins()
    .filter((item) => !targetPluginId || String(item.id || "").trim() === targetPluginId);
  const enabledCount = plugins.filter((item) => item.enabled).length;
  const errorCount = plugins.filter((item) => Number(item.errorCount || 0) > 0).length;
  const timeoutCount = plugins.filter(
    (item) => Number(item.usageTotalTimeouts || 0) > 0
  ).length;
  const persisted = (await readPersistedPluginRecords()).filter(
    (item) => !targetPluginId || item.pluginId === targetPluginId
  );
  const uiExtensions = (await readUiExtensionDescriptors()).filter(
    (item) => !targetPluginId || item.pluginId === targetPluginId
  );
  const panelUiState = await queryPanelUiState();
  let relayActive = false;
  try {
    if (typeof chrome?.runtime?.getContexts === "function") {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType],
      });
      relayActive = contexts.length > 0;
    }
  } catch {
    // getContexts unavailable
  }
  return {
    summary: {
      total: plugins.length,
      enabledCount,
      disabledCount: plugins.length - enabledCount,
      errorCount,
      timeoutCount,
      persistedCount: persisted.length,
      uiExtensionCount: uiExtensions.length,
      filteredByPluginId: targetPluginId || undefined,
    },
    plugins,
    persisted,
    uiExtensions,
    uiState: {
      relayActive,
      panelAvailable: panelUiState !== null,
      plugins: panelUiState ?? {},
    },
    modeProviders: orchestrator.listToolProviders(),
    capabilityProviders: orchestrator.listCapabilityProviders(),
    capabilityPolicies: orchestrator.listCapabilityPolicies(),
    toolContracts: orchestrator.listToolContracts(),
    llmProviders: orchestrator.listLlmProviders()
  };
}

async function buildSkillSnapshot(orchestrator: BrainOrchestrator): Promise<JsonRecord> {
  const skills = await orchestrator.listSkills();
  return {
    summary: {
      total: skills.length,
      enabledCount: skills.filter((item) => item.enabled).length,
      disabledCount: skills.filter((item) => !item.enabled).length,
      disableModelInvocationCount: skills.filter(
        (item) => item.disableModelInvocation
      ).length
    },
    skills,
    resolver: orchestrator.getSkillResolverDebugView()
  };
}

async function buildRuntimeSnapshot(
  orchestrator: BrainOrchestrator,
  sessionId?: string,
  limits: JsonRecord = {},
  pluginId?: string,
): Promise<JsonRecord> {
  const index = await orchestrator.sessions.listSessions();
  const kernel = orchestrator.getKernelDebugState();
  const sessions = await Promise.all(
    index.sessions.map(async (entry) => {
      const meta = await orchestrator.sessions.getMeta(entry.id);
      return {
        id: entry.id,
        title: String(meta?.header?.title || ""),
        updatedAt: String(entry.updatedAt || ""),
        runtime: orchestrator.getRunState(entry.id)
      };
    }),
  );
  const payload: JsonRecord = {
    summary: {
      sessionCount: sessions.length,
      runningCount: sessions.filter((item) => toRecord(item.runtime).running === true)
        .length,
      pausedCount: sessions.filter((item) => toRecord(item.runtime).paused === true)
        .length,
      blockedTraceSessionCount: kernel.blockedTraceSessionIds.length,
      cachedStepStreamSessionCount: kernel.cachedStepStreamSessionIds.length,
      pendingTraceWriteSessionCount: kernel.pendingTraceWriteSessionIds.length
    },
    kernel,
    sessions,
    activity: getRuntimeDebugSnapshot({
      routeLimit: limits.routeLimit,
      pluginMessageLimit: limits.pluginMessageLimit,
      pluginHookLimit: limits.pluginHookLimit,
      internalEventLimit: limits.internalEventLimit,
      pluginId,
      eventTypes: limits.eventTypes,
      text: limits.text,
      errorsOnly: limits.errorsOnly,
      channels: limits.channels,
    })
  };
  if (sessionId) {
    const stepStream = await orchestrator.getStepStream(sessionId);
    const lastEvent = stepStream[stepStream.length - 1] || null;
    payload.session = {
      sessionId,
      runtime: orchestrator.getRunState(sessionId),
      stepStreamCount: stepStream.length,
      lastEvent: lastEvent
        ? {
            type: String(lastEvent.type || ""),
            ts: String(lastEvent.timestamp || ""),
            preview: clipText(
              toRecord(lastEvent.payload).message ||
                toRecord(lastEvent.payload).error ||
                toRecord(lastEvent.payload).action ||
                toRecord(lastEvent.payload).reason ||
                ""
            )
          }
        : null
    };
  }
  return payload;
}

async function buildDebugSnapshot(
  orchestrator: BrainOrchestrator,
  scope: string,
  sessionId?: string,
  limits: JsonRecord = {},
  pluginId?: string,
): Promise<JsonRecord> {
  if (scope === "runtime") {
    return {
      scope,
      ...(await buildRuntimeSnapshot(orchestrator, sessionId, limits, pluginId))
    };
  }
  if (scope === "sandbox") {
    return {
      scope,
      sandbox: getLifoDiagnostics(sessionId)
    };
  }
  if (scope === "plugins") {
    return {
      scope,
      ...(await buildPluginSnapshot(orchestrator, pluginId))
    };
  }
  if (scope === "skills") {
    return {
      scope,
      ...(await buildSkillSnapshot(orchestrator))
    };
  }
  if (scope === "all") {
    return {
      scope,
      runtime: await buildRuntimeSnapshot(orchestrator, sessionId, limits, pluginId),
      sandbox: getLifoDiagnostics(sessionId),
      plugins: await buildPluginSnapshot(orchestrator, pluginId),
      skills: await buildSkillSnapshot(orchestrator)
    };
  }
  throw new Error(`unsupported debug snapshot scope: ${scope}`);
}

export async function handleBrainDebug(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  infra: RuntimeInfraHandler,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.debug.dump") {
    const sessionId =
      typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : "";
    if (sessionId) {
      const meta = await orchestrator.sessions.getMeta(sessionId);
      if (!meta) {
        return fail(`session 不存在: ${sessionId}`);
      }
      const entries = await orchestrator.sessions.getEntries(sessionId);
      const stream = await orchestrator.getStepStream(sessionId);
      const limited = clampStepStream(stream, {
        maxEvents: payload.maxEvents,
        maxBytes: payload.maxBytes,
      });
      const conversationView = await buildConversationView(
        orchestrator,
        sessionId,
      );
      return ok({
        sessionId,
        runtime: orchestrator.getRunState(sessionId),
        meta,
        entryCount: entries.length,
        conversationView,
        sandboxRuntime: getLifoDiagnostics(sessionId),
        stepStream: limited.stream,
        stepStreamMeta: limited.meta,
        globalTail: limited.stream.slice(-80),
      });
    }

    const index = await orchestrator.sessions.listSessions();
    return ok({
      index,
      runningSessions: index.sessions.map((entry) =>
        orchestrator.getRunState(entry.id),
      ),
      sandboxRuntime: getLifoDiagnostics(),
      globalTail: [],
    });
  }

  if (action === "brain.debug.config") {
    const cfgResult = await infra.handleMessage({ type: "config.get" });
    if (!cfgResult || !cfgResult.ok) {
      return fail(cfgResult?.error || "config.get failed");
    }
    const cfg = toRecord(cfgResult.data);
    const profiles = Array.isArray(cfg.llmProfiles)
      ? cfg.llmProfiles.map((item) => toRecord(item))
      : [];
    const llmDefaultProfile = String(cfg.llmDefaultProfile || "default");
    const activeProfile =
      profiles.find(
        (item) => String(item.id || "").trim() === llmDefaultProfile,
      ) ||
      profiles[0] ||
      ({} as Record<string, unknown>);
    const activeProvider =
      String(activeProfile.provider || "openai_compatible").trim() ||
      "openai_compatible";
    const activeModel = String(activeProfile.llmModel || "").trim();
    const hasLlmApiKey =
      activeProvider === "cursor_help_web"
        ? true
        : !!String(activeProfile.llmApiKey || "").trim();
    const systemPromptPreview = await runtimeLoop.getSystemPromptPreview();
    return ok({
      bridgeUrl: String(cfg.bridgeUrl || ""),
      browserRuntimeStrategy: String(
        cfg.browserRuntimeStrategy || "browser-first",
      ),
      llmDefaultProfile,
      llmAuxProfile: String(cfg.llmAuxProfile || ""),
      llmFallbackProfile: String(cfg.llmFallbackProfile || ""),
      llmProfilesCount: profiles.length,
      llmProvider: activeProvider,
      llmModel: activeModel,
      bridgeInvokeTimeoutMs: Number(cfg.bridgeInvokeTimeoutMs || 0),
      llmTimeoutMs: Number(cfg.llmTimeoutMs || 0),
      llmRetryMaxAttempts: Number(cfg.llmRetryMaxAttempts || 0),
      llmMaxRetryDelayMs: Number(cfg.llmMaxRetryDelayMs || 0),
      hasLlmApiKey,
      systemPromptPreview,
    });
  }

  if (action === "brain.debug.plugins") {
    const pluginId =
      typeof payload.pluginId === "string" && payload.pluginId.trim()
        ? payload.pluginId.trim()
        : undefined;
    return ok({
      ...(await buildPluginSnapshot(orchestrator, pluginId)),
      modeProviders: orchestrator.listToolProviders(),
      toolContracts: orchestrator.listToolContracts(),
      llmProviders: orchestrator.listLlmProviders(),
      capabilityProviders: orchestrator.listCapabilityProviders(),
      capabilityPolicies: orchestrator.listCapabilityPolicies(),
    });
  }

  if (action === "brain.debug.runtime") {
    const sessionId =
      typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : undefined;
    const pluginId =
      typeof payload.pluginId === "string" && payload.pluginId.trim()
        ? payload.pluginId.trim()
        : undefined;
    return ok({
      schemaVersion: "bbl.debug.runtime.v1",
      generatedAt: new Date().toISOString(),
      sessionId: sessionId || "",
      pluginId: pluginId || "",
      data: {
        runtime: await buildRuntimeSnapshot(orchestrator, sessionId, payload, pluginId),
        sandbox: getLifoDiagnostics(sessionId),
        plugins: await buildPluginSnapshot(orchestrator, pluginId),
        skills: await buildSkillSnapshot(orchestrator)
      }
    });
  }

  if (action === "brain.debug.snapshot") {
    const scope = String(payload.scope || "all").trim().toLowerCase();
    const sessionId =
      typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : undefined;
    const pluginId =
      typeof payload.pluginId === "string" && payload.pluginId.trim()
        ? payload.pluginId.trim()
        : undefined;
    return ok({
      schemaVersion: "bbl.debug.snapshot.v1",
      generatedAt: new Date().toISOString(),
      sessionId: sessionId || "",
      pluginId: pluginId || "",
      scope,
      data: await buildDebugSnapshot(orchestrator, scope, sessionId, payload, pluginId)
    });
  }

  return fail(`unsupported brain.debug action: ${action}`);
}
