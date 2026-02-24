import { archiveLegacyState, initSessionIndex, resetSessionStore } from "./storage-reset.browser";
import { BrainOrchestrator } from "./orchestrator.browser";
import { createRuntimeInfraHandler, type RuntimeInfraHandler, type RuntimeInfraResult } from "./runtime-infra.browser";
import { createRuntimeLoopController } from "./runtime-loop.browser";
import {
  listSessionEntryChunkKeys,
  listTraceChunkKeys,
  removeSessionIndexEntry,
  removeSessionMeta,
  removeStorageKeys,
  writeSessionMeta
} from "./session-store.browser";
import { nowIso, randomId, type MessageEntry, type SessionEntry, type SessionMeta } from "./types";

interface RuntimeOk<T = unknown> {
  ok: true;
  data: T;
}

interface RuntimeErr {
  ok: false;
  error: string;
}

type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

const SESSION_TITLE_MAX = 28;
const SESSION_TITLE_MIN = 2;
const SESSION_TITLE_SOURCE_MANUAL = "manual";

function ok<T>(data: T): RuntimeResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): RuntimeResult {
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

function fromInfraResult(result: RuntimeInfraResult): RuntimeResult {
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: String(result.error || "runtime infra failed") };
}

function requireSessionId(message: unknown): string {
  const payload = toRecord(message);
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId 不能为空");
  return sessionId;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeSessionTitle(value: unknown, fallback = ""): string {
  const compact = String(value || "")
    .replace(/[`*_>#\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= SESSION_TITLE_MAX) return compact;
  return `${compact.slice(0, SESSION_TITLE_MAX)}…`;
}

function deriveSessionTitleFromEntries(entries: SessionEntry[]): string {
  const list = Array.isArray(entries) ? entries : [];
  for (const item of list) {
    if (item.type !== "message") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text = normalizeSessionTitle(item.text, "");
    if (!text || text.length < SESSION_TITLE_MIN) continue;
    return text;
  }
  return "新对话";
}

function readForkedFrom(meta: SessionMeta | null): {
  sessionId: string;
  leafId: string;
  sourceEntryId: string;
  reason: string;
} | null {
  const metadata = toRecord(meta?.header?.metadata);
  const raw = toRecord(metadata.forkedFrom);
  const sessionId = String(raw.sessionId || "").trim();
  const leafId = String(raw.leafId || "").trim();
  const sourceEntryId = String(raw.sourceEntryId || "").trim();
  const reason = String(raw.reason || "").trim();
  if (!sessionId && !leafId && !sourceEntryId && !reason) return null;
  return { sessionId, leafId, sourceEntryId, reason };
}

function findPreviousUserEntryByChain(
  byId: Map<string, SessionEntry>,
  startEntry: SessionEntry | null | undefined
): MessageEntry | null {
  let cursor: SessionEntry | null = startEntry ?? null;
  let guard = byId.size + 2;
  while (cursor && guard > 0) {
    guard -= 1;
    if (cursor.type === "message" && cursor.role === "user" && String(cursor.id || "").trim()) {
      return cursor;
    }
    const parentId = String(cursor.parentId || "").trim();
    cursor = parentId ? byId.get(parentId) || null : null;
  }
  return null;
}

function findLatestUserEntryInBranch(branch: SessionEntry[]): MessageEntry | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const candidate = branch[i];
    if (candidate.type !== "message" || candidate.role !== "user") continue;
    if (!String(candidate.id || "").trim()) continue;
    if (!String(candidate.text || "").trim()) continue;
    return candidate;
  }
  return null;
}

interface ForkSessionInput {
  sourceSessionId: string;
  leafId: string;
  sourceEntryId?: string;
  reason?: string;
  title?: string;
  targetSessionId?: string;
}

interface ForkSessionResult {
  sessionId: string;
  sourceSessionId: string;
  sourceLeafId: string;
  leafId: string | null;
  copiedEntryCount: number;
}

async function forkSessionFromLeaf(
  orchestrator: BrainOrchestrator,
  input: ForkSessionInput
): Promise<ForkSessionResult> {
  const sourceSessionId = String(input.sourceSessionId || "").trim();
  const sourceLeafId = String(input.leafId || "").trim();
  if (!sourceSessionId) {
    throw new Error("fork sourceSessionId 不能为空");
  }
  if (!sourceLeafId) {
    throw new Error("fork leafId 不能为空");
  }

  const sourceMeta = await orchestrator.sessions.getMeta(sourceSessionId);
  if (!sourceMeta) {
    throw new Error(`session 不存在: ${sourceSessionId}`);
  }

  const sourceEntries = await orchestrator.sessions.getEntries(sourceSessionId);
  const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  if (!byId.has(sourceLeafId)) {
    throw new Error(`fork leaf 不存在: ${sourceLeafId}`);
  }

  const sourceTitle = String(sourceMeta.header.title || "").trim();
  const forkTitle = String(input.title || "").trim() || (sourceTitle ? `${sourceTitle} · 重答分支` : "重答分支");
  const sourceMetadata = toRecord(sourceMeta.header.metadata);
  const forkReason = String(input.reason || "manual");
  const sourceEntryId = String(input.sourceEntryId || "");
  const targetSessionId = String(input.targetSessionId || "").trim() || undefined;

  const forkMeta = await orchestrator.sessions.createSession({
    id: targetSessionId,
    parentSessionId: sourceSessionId,
    title: forkTitle,
    model: sourceMeta.header.model,
    metadata: {
      ...sourceMetadata,
      forkedFrom: {
        sessionId: sourceSessionId,
        leafId: sourceLeafId,
        sourceEntryId,
        reason: forkReason
      }
    }
  });
  const forkSessionId = forkMeta.header.id;

  const branch = await orchestrator.sessions.getBranch(sourceSessionId, sourceLeafId);
  const oldToNew = new Map<string, string>();
  for (const sourceEntry of branch) {
    const cloned: SessionEntry = {
      ...sourceEntry,
      id: randomId("entry"),
      parentId: sourceEntry.parentId ? oldToNew.get(sourceEntry.parentId) || null : null,
      timestamp: nowIso()
    };
    if (cloned.type === "compaction") {
      const oldFirstKept = String(cloned.firstKeptEntryId || "").trim();
      cloned.firstKeptEntryId = oldFirstKept ? oldToNew.get(oldFirstKept) || null : null;
    }
    await orchestrator.sessions.appendEntry(forkSessionId, cloned);
    oldToNew.set(sourceEntry.id, cloned.id);
  }

  return {
    sessionId: forkSessionId,
    sourceSessionId,
    sourceLeafId,
    leafId: oldToNew.get(sourceLeafId) || null,
    copiedEntryCount: branch.length
  };
}

async function buildConversationView(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  leafId?: string | null
): Promise<{
  sessionId: string;
  messageCount: number;
  messages: Array<{
    role: string;
    content: string;
    entryId: string;
    toolName?: string;
    toolCallId?: string;
  }>;
  parentSessionId: string;
  forkedFrom: { sessionId: string; leafId: string; sourceEntryId: string; reason: string } | null;
  lastStatus: ReturnType<BrainOrchestrator["getRunState"]>;
  updatedAt: string;
}> {
  const context = await orchestrator.sessions.buildSessionContext(sessionId, leafId ?? undefined);
  const meta = await orchestrator.sessions.getMeta(sessionId);
  return {
    sessionId,
    messageCount: context.messages.length,
    messages: context.messages,
    parentSessionId: String(meta?.header?.parentSessionId || ""),
    forkedFrom: readForkedFrom(meta),
    lastStatus: orchestrator.getRunState(sessionId),
    updatedAt: nowIso()
  };
}

async function handleBrainRun(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  if (action === "brain.run.start") {
    const out = await runtimeLoop.startFromPrompt({
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      sessionOptions: payload.sessionOptions ? toRecord(payload.sessionOptions) : {},
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      tabIds: Array.isArray(payload.tabIds) ? payload.tabIds : undefined,
      autoRun: payload.autoRun === false ? false : true
    });
    return ok(out);
  }

  if (action === "brain.run.regenerate") {
    const sessionId = requireSessionId(payload);
    await orchestrator.sessions.ensureSession(sessionId);

    const sourceEntryId = String(payload.sourceEntryId || "").trim();
    if (!sourceEntryId) {
      return fail("brain.run.regenerate 需要 sourceEntryId");
    }

    const entries = await orchestrator.sessions.getEntries(sessionId);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const source = byId.get(sourceEntryId);
    if (!source) {
      return fail(`regenerate sourceEntry 不存在: ${sourceEntryId}`);
    }
    if (source.type !== "message" || source.role !== "assistant") {
      return fail("regenerate sourceEntry 必须是 assistant 消息");
    }

    const requireSourceIsLeaf = payload.requireSourceIsLeaf === true;
    const rebaseLeafToPreviousUser = payload.rebaseLeafToPreviousUser === true;
    const currentLeafId = (await orchestrator.sessions.getLeaf(sessionId)) || "";
    if (requireSourceIsLeaf && currentLeafId !== sourceEntryId) {
      return fail("仅最后一条 assistant 支持当前会话重试");
    }

    const previousSeed = String(source.parentId || "").trim();
    const previousEntry = previousSeed ? byId.get(previousSeed) : undefined;
    const previousUser = findPreviousUserEntryByChain(byId, previousEntry);
    if (!previousUser) {
      return fail("未找到前序 user 消息，无法重试");
    }

    if (rebaseLeafToPreviousUser && currentLeafId !== previousUser.id) {
      await orchestrator.sessions.setLeaf(sessionId, previousUser.id);
    }

    orchestrator.events.emit("input.regenerate", sessionId, {
      sourceEntryId,
      previousUserEntryId: previousUser.id,
      text: String(previousUser.text || "")
    });

    const out = await runtimeLoop.startFromRegenerate({
      sessionId,
      prompt: String(previousUser.text || ""),
      autoRun: payload.autoRun === false ? false : true
    });
    return ok(out);
  }

  if (action === "brain.run.edit_rerun") {
    const sourceSessionId = requireSessionId(payload);
    await orchestrator.sessions.ensureSession(sourceSessionId);

    const sourceEntryId = String(payload.sourceEntryId || payload.entryId || "").trim();
    if (!sourceEntryId) {
      return fail("brain.run.edit_rerun 需要 sourceEntryId");
    }
    const editedPrompt = String(payload.prompt || "").trim();
    if (!editedPrompt) {
      return fail("brain.run.edit_rerun 需要非空 prompt");
    }

    const sourceEntries = await orchestrator.sessions.getEntries(sourceSessionId);
    const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    const targetEntry = byId.get(sourceEntryId);
    if (!targetEntry) {
      return fail(`edit_rerun sourceEntry 不存在: ${sourceEntryId}`);
    }
    if (targetEntry.type !== "message" || targetEntry.role !== "user") {
      return fail("edit_rerun sourceEntry 必须是 user 消息");
    }

    const activeLeafId = (await orchestrator.sessions.getLeaf(sourceSessionId)) || null;
    const activeBranch = await orchestrator.sessions.getBranch(sourceSessionId, activeLeafId ?? undefined);
    if (!activeBranch.some((entry) => entry.id === sourceEntryId)) {
      return fail("edit_rerun sourceEntry 不在当前分支");
    }
    const latestUser = findLatestUserEntryInBranch(activeBranch);
    if (!latestUser) {
      return fail("当前分支缺少可编辑 user 消息");
    }
    const mode: "retry" | "fork" = latestUser.id === sourceEntryId ? "retry" : "fork";
    const autoRun = payload.autoRun === false ? false : true;

    let runSessionId = sourceSessionId;
    let runSourceEntryId = sourceEntryId;
    if (mode === "fork") {
      const forked = await forkSessionFromLeaf(orchestrator, {
        sourceSessionId,
        leafId: sourceEntryId,
        sourceEntryId,
        reason: String(payload.reason || "edit_user_rerun"),
        title: String(payload.title || "").trim() || undefined
      });
      runSessionId = forked.sessionId;
      runSourceEntryId = String(forked.leafId || "").trim();
      if (!runSourceEntryId) {
        return fail("edit_rerun fork 后未找到 sourceEntry");
      }
    }

    const runEntries = await orchestrator.sessions.getEntries(runSessionId);
    const runById = new Map(runEntries.map((entry) => [entry.id, entry]));
    const runSource = runById.get(runSourceEntryId);
    if (!runSource || runSource.type !== "message" || runSource.role !== "user") {
      return fail("edit_rerun 目标 user 节点异常");
    }

    const rebaseLeafId = runSource.parentId || null;
    const currentLeafId = (await orchestrator.sessions.getLeaf(runSessionId)) || null;
    if (currentLeafId !== rebaseLeafId) {
      await orchestrator.sessions.setLeaf(runSessionId, rebaseLeafId);
    }

    orchestrator.events.emit("input.regenerate", runSessionId, {
      sourceEntryId: runSourceEntryId,
      previousUserEntryId: runSourceEntryId,
      text: editedPrompt,
      mode,
      reason: "edit_user_rerun"
    });

    const out = await runtimeLoop.startFromPrompt({
      sessionId: runSessionId,
      prompt: editedPrompt,
      autoRun
    });

    return ok({
      ...out,
      mode,
      sourceSessionId,
      sourceEntryId,
      activeSourceEntryId: runSourceEntryId
    });
  }

  if (action === "brain.run.pause") {
    return ok(orchestrator.pause(requireSessionId(payload)));
  }

  if (action === "brain.run.resume") {
    return ok(orchestrator.resume(requireSessionId(payload)));
  }

  if (action === "brain.run.stop") {
    return ok(orchestrator.stop(requireSessionId(payload)));
  }

  return fail(`unsupported brain.run action: ${action}`);
}

async function handleSession(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.session.list") {
    const index = await orchestrator.sessions.listSessions();
    const sessions = await Promise.all(
      index.sessions.map(async (entry) => {
        const meta = await orchestrator.sessions.getMeta(entry.id);
        return {
          ...entry,
          title: normalizeSessionTitle(meta?.header?.title, ""),
          parentSessionId: String(meta?.header?.parentSessionId || ""),
          forkedFrom: readForkedFrom(meta)
        };
      })
    );
    return ok({ ...index, sessions });
  }

  if (action === "brain.session.get") {
    const sessionId = requireSessionId(payload);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    const entries = await orchestrator.sessions.getEntries(sessionId);
    return ok({ meta, entries });
  }

  if (action === "brain.session.view") {
    const sessionId = requireSessionId(payload);
    const leafId = typeof payload.leafId === "string" ? payload.leafId : undefined;
    return ok({
      conversationView: await buildConversationView(orchestrator, sessionId, leafId)
    });
  }

  if (action === "brain.session.fork") {
    const sessionId = requireSessionId(payload);
    const leafId = String(payload.leafId || "").trim();
    if (!leafId) {
      return fail("brain.session.fork 需要 leafId");
    }
    const forked = await forkSessionFromLeaf(orchestrator, {
      sourceSessionId: sessionId,
      leafId,
      sourceEntryId: String(payload.sourceEntryId || ""),
      reason: String(payload.reason || "manual"),
      title: String(payload.title || "").trim() || undefined,
      targetSessionId: String(payload.targetSessionId || "").trim() || undefined
    });
    return ok(forked);
  }

  if (action === "brain.session.title.refresh") {
    const sessionId = requireSessionId(payload);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    if (!meta) {
      return fail(`session 不存在: ${sessionId}`);
    }
    const hasExplicitTitle = typeof payload.title === "string";
    if (hasExplicitTitle) {
      const manualTitle = normalizeSessionTitle(payload.title, "");
      if (!manualTitle) {
        return fail("title 不能为空");
      }
      const metadata = {
        ...toRecord(meta.header.metadata),
        titleSource: SESSION_TITLE_SOURCE_MANUAL
      };
      await writeSessionMeta(sessionId, {
        ...meta,
        header: {
          ...meta.header,
          title: manualTitle,
          metadata
        },
        updatedAt: nowIso()
      });
      return ok({
        sessionId,
        title: manualTitle,
        updated: manualTitle !== normalizeSessionTitle(meta.header.title, "")
      });
    }
    const currentTitle = normalizeSessionTitle(meta.header.title, "");
    const force = payload.force === true;
    const derivedTitle = await runtimeLoop.refreshSessionTitle(sessionId, { force });
    if (!derivedTitle) {
      const entries = await orchestrator.sessions.getEntries(sessionId);
      const fallbackTitle = currentTitle || deriveSessionTitleFromEntries(entries);
      const normalizedFallback = normalizeSessionTitle(fallbackTitle, "新对话");
      if (normalizedFallback && normalizedFallback !== currentTitle) {
        await writeSessionMeta(sessionId, {
          ...meta,
          header: {
            ...meta.header,
            title: normalizedFallback
          },
          updatedAt: nowIso()
        });
      }
      return ok({
        sessionId,
        title: normalizedFallback || currentTitle,
        updated: normalizedFallback !== currentTitle
      });
    }
    return ok({
      sessionId,
      title: derivedTitle,
      updated: derivedTitle !== currentTitle
    });
  }

  if (action === "brain.session.delete") {
    const sessionId = requireSessionId(payload);
    const entryKeys = await listSessionEntryChunkKeys(sessionId);
    const traceKeys = await listTraceChunkKeys(`session-${sessionId}`);
    const metaKey = `session:${sessionId}:meta`;
    const removable = [...entryKeys, ...traceKeys];
    await removeStorageKeys(removable);
    await removeSessionMeta(sessionId);
    const index = await removeSessionIndexEntry(sessionId, nowIso());
    orchestrator.stop(sessionId);
    return ok({
      sessionId,
      deleted: true,
      removedCount: removable.length + 1,
      removedKeys: [metaKey, ...removable],
      index
    });
  }

  return fail(`unsupported brain.session action: ${action}`);
}

async function handleStep(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const type = String(payload.type || "");
  if (type === "brain.step.stream") {
    const sessionId = requireSessionId(payload);
    const stream = await orchestrator.getStepStream(sessionId);
    return ok({ sessionId, stream });
  }

  if (type === "brain.step.execute") {
    const sessionId = requireSessionId(payload);
    const modeRaw = String(payload.mode || "").trim();
    const mode = ["script", "cdp", "bridge"].includes(modeRaw) ? (modeRaw as "script" | "cdp" | "bridge") : undefined;
    const capability = String(payload.capability || "").trim() || undefined;
    const action = String(payload.action || "").trim();
    if (modeRaw && !mode) return fail("mode 必须是 script/cdp/bridge");
    if (!mode && !capability) return fail("mode 或 capability 至少需要一个");
    if (!action) return fail("action 不能为空");
    return ok(
      await runtimeLoop.executeStep({
        sessionId,
        mode,
        capability,
        action,
        args: toRecord(payload.args),
        verifyPolicy: payload.verifyPolicy as "off" | "on_critical" | "always" | undefined
      })
    );
  }

  return fail(`unsupported step action: ${type}`);
}

async function handleStorage(message: unknown): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  if (action === "brain.storage.archive") {
    return ok(await archiveLegacyState(toRecord(payload.options)));
  }
  if (action === "brain.storage.reset") {
    return ok(await resetSessionStore(toRecord(payload.options) || { archiveLegacyBeforeReset: true }));
  }
  if (action === "brain.storage.init") {
    return ok(await initSessionIndex());
  }
  return fail(`unsupported storage action: ${action}`);
}

async function handleBrainDebug(orchestrator: BrainOrchestrator, infra: RuntimeInfraHandler, message: unknown): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.debug.dump") {
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "";
    if (sessionId) {
      const meta = await orchestrator.sessions.getMeta(sessionId);
      if (!meta) {
        return fail(`session 不存在: ${sessionId}`);
      }
      const entries = await orchestrator.sessions.getEntries(sessionId);
      const stream = await orchestrator.getStepStream(sessionId);
      const conversationView = await buildConversationView(orchestrator, sessionId);
      return ok({
        sessionId,
        runtime: orchestrator.getRunState(sessionId),
        meta,
        entryCount: entries.length,
        conversationView,
        stepStream: stream,
        globalTail: stream.slice(-80)
      });
    }

    const index = await orchestrator.sessions.listSessions();
    return ok({
      index,
      runningSessions: index.sessions.map((entry) => orchestrator.getRunState(entry.id)),
      globalTail: []
    });
  }

  if (action === "brain.debug.config") {
    const cfgResult = await infra.handleMessage({ type: "config.get" });
    if (!cfgResult || !cfgResult.ok) {
      return fail(cfgResult?.error || "config.get failed");
    }
    const cfg = toRecord(cfgResult.data);
    return ok({
      bridgeUrl: String(cfg.bridgeUrl || ""),
      llmApiBase: String(cfg.llmApiBase || ""),
      llmModel: String(cfg.llmModel || "gpt-5.3-codex"),
      bridgeInvokeTimeoutMs: Number(cfg.bridgeInvokeTimeoutMs || 0),
      llmTimeoutMs: Number(cfg.llmTimeoutMs || 0),
      llmRetryMaxAttempts: Number(cfg.llmRetryMaxAttempts || 0),
      llmMaxRetryDelayMs: Number(cfg.llmMaxRetryDelayMs || 0),
      hasLlmApiKey: !!String(cfg.llmApiKey || "").trim()
    });
  }

  if (action === "brain.debug.plugins") {
    return ok({
      plugins: orchestrator.listPlugins(),
      modeProviders: orchestrator.listToolProviders(),
      capabilityProviders: orchestrator.listCapabilityProviders(),
      capabilityPolicies: orchestrator.listCapabilityPolicies()
    });
  }

  return fail(`unsupported brain.debug action: ${action}`);
}

export function registerRuntimeRouter(orchestrator: BrainOrchestrator): void {
  const infra = createRuntimeInfraHandler();
  const runtimeLoop = createRuntimeLoopController(orchestrator, infra);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const run = async () => {
      const routeBefore = await orchestrator.runHook("runtime.route.before", {
        type: String(message?.type || ""),
        message
      });
      if (routeBefore.blocked) {
        return fail(`runtime.route.before blocked: ${routeBefore.reason || "blocked"}`);
      }
      const routeInput = routeBefore.value;
      const type = String(routeInput.type || "");
      const routeMessage = routeInput.message as unknown;
      const applyAfter = async (result: RuntimeResult): Promise<RuntimeResult> => {
        const afterHook = await orchestrator.runHook("runtime.route.after", {
          type,
          message: routeMessage,
          result
        });
        return afterHook.blocked ? result : (afterHook.value.result as RuntimeResult);
      };

      try {
        if (type === "ping") {
          return await applyAfter(ok({ source: "service-worker", version: "vnext" }));
        }

        const infraResult = await infra.handleMessage(routeMessage);
        if (infraResult) return await applyAfter(fromInfraResult(infraResult));

        if (type.startsWith("brain.run.")) {
          return await applyAfter(await handleBrainRun(orchestrator, runtimeLoop, routeMessage));
        }

        if (type.startsWith("brain.session.")) {
          return await applyAfter(await handleSession(orchestrator, runtimeLoop, routeMessage));
        }

        if (type.startsWith("brain.step.")) {
          return await applyAfter(await handleStep(orchestrator, runtimeLoop, routeMessage));
        }

        if (type.startsWith("brain.storage.")) {
          return await applyAfter(await handleStorage(routeMessage));
        }

        if (type.startsWith("brain.debug.")) {
          return await applyAfter(await handleBrainDebug(orchestrator, infra, routeMessage));
        }

        if (type === "brain.agent.end") {
          const payload = toRecord(toRecord(routeMessage).payload);
          const sessionId = String(payload.sessionId || "").trim();
          if (!sessionId) return fail("brain.agent.end 需要 payload.sessionId");

          const rawError = toRecord(payload.error);
          const statusNumber = Number(rawError.status);
          const error =
            Object.keys(rawError).length === 0
              ? null
              : {
                  message: typeof rawError.message === "string" ? rawError.message : undefined,
                  code: typeof rawError.code === "string" ? rawError.code : undefined,
                  status: Number.isFinite(statusNumber) ? statusNumber : undefined
                };

          return await applyAfter(
            ok(
              await orchestrator.handleAgentEnd({
                sessionId,
                error,
                overflow: payload.overflow === true
              })
            )
          );
        }

        return await applyAfter(fail(`Unknown message type: ${type}`));
      } catch (error) {
        await orchestrator.runHook("runtime.route.error", {
          type,
          message: routeMessage,
          error: error instanceof Error ? error.message : String(error)
        });
        return await applyAfter(fail(error));
      }
    };

    void run().then((result) => sendResponse(result));
    return true;
  });
}
