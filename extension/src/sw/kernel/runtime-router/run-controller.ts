import type { RuntimeInfraHandler } from "../runtime-infra.browser";
import type { RuntimeLoopController } from "../runtime-loop.browser";
import type { BrainOrchestrator } from "../orchestrator.browser";
import type { MessageEntry, SessionEntry } from "../types";
import { forkSessionFromLeaf } from "./session-utils";

type RuntimeOk<T = unknown> = { ok: true; data: T };
type RuntimeErr = { ok: false; error: string };
type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

function ok<T>(data: T): RuntimeOk<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeErr {
  return { ok: false, error };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function requireSessionId(message: unknown): string {
  const payload = toRecord(message);
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId 不能为空");
  return sessionId;
}

function findPreviousUserEntryByChain(
  byId: Map<string, SessionEntry>,
  startEntry: SessionEntry | null | undefined,
): MessageEntry | null {
  let cursor: SessionEntry | null = startEntry ?? null;
  let guard = byId.size + 2;
  while (cursor && guard > 0) {
    guard -= 1;
    if (
      cursor.type === "message" &&
      cursor.role === "user" &&
      String(cursor.id || "").trim()
    ) {
      return cursor;
    }
    const parentId = String(cursor.parentId || "").trim();
    cursor = parentId ? byId.get(parentId) || null : null;
  }
  return null;
}

function findLatestUserEntryInBranch(
  branch: SessionEntry[],
): MessageEntry | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const candidate = branch[i];
    if (candidate.type !== "message" || candidate.role !== "user") continue;
    if (!String(candidate.id || "").trim()) continue;
    if (!String(candidate.text || "").trim()) continue;
    return candidate;
  }
  return null;
}

export async function handleBrainRun(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  infra: RuntimeInfraHandler,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  if (action === "brain.run.start") {
    const rawStreamingBehavior =
      typeof payload.streamingBehavior === "string"
        ? payload.streamingBehavior
        : typeof payload.deliverAs === "string"
          ? payload.deliverAs
          : "";
    const streamingBehavior =
      rawStreamingBehavior === "follow_up"
        ? "followUp"
        : rawStreamingBehavior === "steer" ||
            rawStreamingBehavior === "followUp"
          ? rawStreamingBehavior
          : undefined;
    const out = await runtimeLoop.startFromPrompt({
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      sessionOptions: payload.sessionOptions
        ? toRecord(payload.sessionOptions)
        : {},
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      tabIds: Array.isArray(payload.tabIds) ? payload.tabIds : undefined,
      skillIds: Array.isArray(payload.skillIds) ? payload.skillIds : undefined,
      contextRefs: Array.isArray(payload.contextRefs)
        ? payload.contextRefs
        : undefined,
      autoRun: payload.autoRun === false ? false : true,
      streamingBehavior,
    });
    return ok(out);
  }

  if (action === "brain.run.steer" || action === "brain.run.follow_up") {
    const sessionId = requireSessionId(payload);
    const prompt = String(payload.prompt || "").trim();
    const skillIds = Array.isArray(payload.skillIds)
      ? payload.skillIds
      : undefined;
    const contextRefs = Array.isArray(payload.contextRefs)
      ? payload.contextRefs
      : undefined;
    if (
      !prompt &&
      (!skillIds || skillIds.length === 0) &&
      (!contextRefs || contextRefs.length === 0)
    ) {
      return fail(`${action} 需要非空 prompt、skillIds 或 contextRefs`);
    }
    const out = await runtimeLoop.startFromPrompt({
      sessionId,
      prompt,
      skillIds,
      contextRefs,
      autoRun: true,
      streamingBehavior: action === "brain.run.steer" ? "steer" : "followUp",
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
    const currentLeafId =
      (await orchestrator.sessions.getLeaf(sessionId)) || "";
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
      text: String(previousUser.text || ""),
    });

    const out = await runtimeLoop.startFromRegenerate({
      sessionId,
      prompt: String(previousUser.text || ""),
      autoRun: payload.autoRun === false ? false : true,
    });
    return ok(out);
  }

  if (action === "brain.run.edit_rerun") {
    const sourceSessionId = requireSessionId(payload);
    await orchestrator.sessions.ensureSession(sourceSessionId);

    const sourceEntryId = String(
      payload.sourceEntryId || payload.entryId || "",
    ).trim();
    if (!sourceEntryId) {
      return fail("brain.run.edit_rerun 需要 sourceEntryId");
    }
    const editedPrompt = String(payload.prompt || "").trim();
    if (!editedPrompt) {
      return fail("brain.run.edit_rerun 需要非空 prompt");
    }

    const sourceEntries =
      await orchestrator.sessions.getEntries(sourceSessionId);
    const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    const targetEntry = byId.get(sourceEntryId);
    if (!targetEntry) {
      return fail(`edit_rerun sourceEntry 不存在: ${sourceEntryId}`);
    }
    if (targetEntry.type !== "message" || targetEntry.role !== "user") {
      return fail("edit_rerun sourceEntry 必须是 user 消息");
    }

    const activeLeafId =
      (await orchestrator.sessions.getLeaf(sourceSessionId)) || null;
    const activeBranch = await orchestrator.sessions.getBranch(
      sourceSessionId,
      activeLeafId ?? undefined,
    );
    if (!activeBranch.some((entry) => entry.id === sourceEntryId)) {
      return fail("edit_rerun sourceEntry 不在当前分支");
    }
    const latestUser = findLatestUserEntryInBranch(activeBranch);
    if (!latestUser) {
      return fail("当前分支缺少可编辑 user 消息");
    }
    const mode: "retry" | "fork" =
      latestUser.id === sourceEntryId ? "retry" : "fork";
    const autoRun = payload.autoRun === false ? false : true;

    let runSessionId = sourceSessionId;
    let runSourceEntryId = sourceEntryId;
    if (mode === "fork") {
      const forked = await forkSessionFromLeaf(orchestrator, {
        sourceSessionId,
        leafId: sourceEntryId,
        sourceEntryId,
        reason: String(payload.reason || "edit_user_rerun"),
        title: String(payload.title || "").trim() || undefined,
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
    if (
      !runSource ||
      runSource.type !== "message" ||
      runSource.role !== "user"
    ) {
      return fail("edit_rerun 目标 user 节点异常");
    }

    const rebaseLeafId = runSource.parentId || null;
    const currentLeafId =
      (await orchestrator.sessions.getLeaf(runSessionId)) || null;
    if (currentLeafId !== rebaseLeafId) {
      await orchestrator.sessions.setLeaf(runSessionId, rebaseLeafId);
    }

    orchestrator.events.emit("input.regenerate", runSessionId, {
      sourceEntryId: runSourceEntryId,
      previousUserEntryId: runSourceEntryId,
      text: editedPrompt,
      mode,
      reason: "edit_user_rerun",
    });

    if (autoRun && mode === "retry") {
      const settleDeadline = Date.now() + 300;
      while (
        orchestrator.getRunState(runSessionId).running &&
        Date.now() < settleDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const out = await runtimeLoop.startFromPrompt({
      sessionId: runSessionId,
      prompt: editedPrompt,
      autoRun,
    });

    return ok({
      ...out,
      mode,
      sourceSessionId,
      sourceEntryId,
      activeSourceEntryId: runSourceEntryId,
    });
  }

  if (action === "brain.run.pause") {
    return ok(orchestrator.pause(requireSessionId(payload)));
  }

  if (action === "brain.run.queue.promote") {
    const sessionId = requireSessionId(payload);
    const queuedPromptId = String(
      payload.queuedPromptId || payload.id || "",
    ).trim();
    if (!queuedPromptId) {
      return fail("brain.run.queue.promote 需要 queuedPromptId");
    }
    const rawTarget = String(
      payload.targetBehavior || payload.behavior || "steer",
    ).trim();
    const targetBehavior = rawTarget === "followUp" ? "followUp" : "steer";
    const runtime = orchestrator.promoteQueuedPrompt(
      sessionId,
      queuedPromptId,
      targetBehavior,
    );
    if (
      targetBehavior === "steer" &&
      runtime.running === true &&
      runtime.stopped !== true
    ) {
      infra.abortBridgeInvokesBySession(sessionId, "steer_preempt");
    }
    return ok(runtime);
  }

  if (action === "brain.run.resume") {
    return ok(orchestrator.resume(requireSessionId(payload)));
  }

  if (action === "brain.run.stop") {
    const sessionId = requireSessionId(payload);
    const runtime = orchestrator.stop(sessionId);
    infra.abortBridgeInvokesBySession(sessionId);
    return ok(runtime);
  }

  return fail(`unsupported brain.run action: ${action}`);
}
