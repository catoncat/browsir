import { clearVirtualFilesForSession } from "../browser-unix-runtime/lifo-adapter";
import type { BrainOrchestrator } from "../orchestrator.browser";
import type { RuntimeLoopController } from "../runtime-loop.browser";
import {
  removeSessionIndexEntry,
  removeSessionMeta,
  removeTraceRecords,
  writeSessionMeta,
} from "../session-store.browser";
import { nowIso } from "../types";
import { clearSessionPreferences } from "../cursor-help-slot-preferences";
import {
  buildConversationView,
  deriveSessionTitleFromEntries,
  forkSessionFromLeaf,
  normalizeSessionTitle,
  readForkedFrom,
} from "./session-utils";

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

const SESSION_TITLE_SOURCE_MANUAL = "manual";

export async function handleSession(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  message: unknown,
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
          forkedFrom: readForkedFrom(meta),
        };
      }),
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
    const leafId =
      typeof payload.leafId === "string" ? payload.leafId : undefined;
    return ok({
      conversationView: await buildConversationView(
        orchestrator,
        sessionId,
        leafId,
      ),
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
      targetSessionId:
        String(payload.targetSessionId || "").trim() || undefined,
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
        titleSource: SESSION_TITLE_SOURCE_MANUAL,
      };
      await writeSessionMeta(sessionId, {
        ...meta,
        header: {
          ...meta.header,
          title: manualTitle,
          metadata,
        },
        updatedAt: nowIso(),
      });
      return ok({
        sessionId,
        title: manualTitle,
        updated: manualTitle !== normalizeSessionTitle(meta.header.title, ""),
      });
    }
    const currentTitle = normalizeSessionTitle(meta.header.title, "");
    const force = payload.force === true;
    const derivedTitle = await runtimeLoop.refreshSessionTitle(sessionId, {
      force,
    });
    if (!derivedTitle) {
      const entries = await orchestrator.sessions.getEntries(sessionId);
      const fallbackTitle =
        currentTitle || deriveSessionTitleFromEntries(entries);
      const normalizedFallback = normalizeSessionTitle(fallbackTitle, "新对话");
      if (normalizedFallback && normalizedFallback !== currentTitle) {
        await writeSessionMeta(sessionId, {
          ...meta,
          header: {
            ...meta.header,
            title: normalizedFallback,
          },
          updatedAt: nowIso(),
        });
      }
      return ok({
        sessionId,
        title: normalizedFallback || currentTitle,
        updated: normalizedFallback !== currentTitle,
      });
    }
    return ok({
      sessionId,
      title: derivedTitle,
      updated: derivedTitle !== currentTitle,
    });
  }

  if (action === "brain.session.delete") {
    const sessionId = requireSessionId(payload);
    const metaKey = `session:${sessionId}:meta`;
    orchestrator.stop(sessionId);
    await orchestrator.flushSessionTraceWrites(sessionId);
    await removeSessionMeta(sessionId);
    const removedTraceCount = await removeTraceRecords(`session-${sessionId}`);
    const removedVirtualKeys = await clearVirtualFilesForSession(sessionId);
    const index = await removeSessionIndexEntry(sessionId, nowIso());
    await orchestrator.evictSessionRuntime(sessionId);
    clearSessionPreferences(sessionId);
    return ok({
      sessionId,
      deleted: true,
      removedCount: 1 + removedTraceCount + removedVirtualKeys.length,
      removedKeys: [
        metaKey,
        ...removedVirtualKeys,
        ...(removedTraceCount > 0 ? [`trace:session-${sessionId}`] : []),
      ],
      index,
    });
  }

  return fail(`unsupported brain.session action: ${action}`);
}
