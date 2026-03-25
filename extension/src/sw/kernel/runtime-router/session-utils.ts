import type { BrainOrchestrator } from "../orchestrator.browser";
import { nowIso, randomId, type ContentBlock, type MessageEntry, type SessionEntry, type SessionMeta } from "../types";

const SESSION_TITLE_MAX = 28;
const SESSION_TITLE_MIN = 2;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeSessionTitle(value: unknown, fallback = ""): string {
  const compact = String(value || "")
    .replace(/[`*_>#\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= SESSION_TITLE_MAX) return compact;
  return `${compact.slice(0, SESSION_TITLE_MAX)}…`;
}

export function deriveSessionTitleFromEntries(entries: SessionEntry[]): string {
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

export function readForkedFrom(meta: SessionMeta | null): {
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

export interface ForkSessionInput {
  sourceSessionId: string;
  leafId: string;
  sourceEntryId?: string;
  reason?: string;
  title?: string;
  targetSessionId?: string;
}

export interface ForkSessionResult {
  sessionId: string;
  sourceSessionId: string;
  sourceLeafId: string;
  leafId: string | null;
  copiedEntryCount: number;
}

export async function forkSessionFromLeaf(
  orchestrator: BrainOrchestrator,
  input: ForkSessionInput,
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
  const forkTitle =
    String(input.title || "").trim() ||
    (sourceTitle ? `${sourceTitle} · 重答分支` : "重答分支");
  const sourceMetadata = toRecord(sourceMeta.header.metadata);
  const forkReason = String(input.reason || "manual");
  const sourceEntryId = String(input.sourceEntryId || "");
  const targetSessionId =
    String(input.targetSessionId || "").trim() || undefined;

  const forkMeta = await orchestrator.sessions.createSession({
    id: targetSessionId,
    parentSessionId: sourceSessionId,
    title: forkTitle,
    model: sourceMeta.header.model,
    workingContext: sourceMeta.header.workingContext,
    metadata: {
      ...sourceMetadata,
      forkedFrom: {
        sessionId: sourceSessionId,
        leafId: sourceLeafId,
        sourceEntryId,
        reason: forkReason,
      },
    },
  });
  const forkSessionId = forkMeta.header.id;

  const branch = await orchestrator.sessions.getBranch(
    sourceSessionId,
    sourceLeafId,
  );
  const oldToNew = new Map<string, string>();
  for (const sourceEntry of branch) {
    const cloned: SessionEntry = {
      ...sourceEntry,
      id: randomId("entry"),
      parentId: sourceEntry.parentId
        ? oldToNew.get(sourceEntry.parentId) || null
        : null,
      timestamp: nowIso(),
    };
    if (cloned.type === "compaction") {
      const oldFirstKept = String(cloned.firstKeptEntryId || "").trim();
      cloned.firstKeptEntryId = oldFirstKept
        ? oldToNew.get(oldFirstKept) || null
        : null;
    }
    await orchestrator.sessions.appendEntry(forkSessionId, cloned);
    oldToNew.set(sourceEntry.id, cloned.id);
  }

  return {
    sessionId: forkSessionId,
    sourceSessionId,
    sourceLeafId,
    leafId: oldToNew.get(sourceLeafId) || null,
    copiedEntryCount: branch.length,
  };
}

export async function buildConversationView(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  leafId?: string | null,
): Promise<{
  sessionId: string;
  messageCount: number;
  messages: Array<{
    role: string;
    content: string;
    contentBlocks?: ContentBlock[];
    entryId: string;
    toolName?: string;
    toolCallId?: string;
    metadata?: Record<string, unknown>;
  }>;
  parentSessionId: string;
  forkedFrom: {
    sessionId: string;
    leafId: string;
    sourceEntryId: string;
    reason: string;
  } | null;
  lastStatus: ReturnType<BrainOrchestrator["getRunState"]>;
  updatedAt: string;
}> {
  const context = await orchestrator.sessions.buildSessionContext(
    sessionId,
    leafId ?? undefined,
  );
  const meta = await orchestrator.sessions.getMeta(sessionId);
  const messages = context.entries
    .filter((entry): entry is MessageEntry => entry.type === "message")
    .map((entry) => ({
      role: entry.role,
      content: entry.text,
      ...(entry.contentBlocks?.length ? { contentBlocks: entry.contentBlocks } : {}),
      entryId: entry.id,
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      ...(entry.role === "user" && entry.metadata ? { metadata: entry.metadata } : {}),
    }));
  return {
    sessionId,
    messageCount: messages.length,
    messages,
    parentSessionId: String(meta?.header?.parentSessionId || ""),
    forkedFrom: readForkedFrom(meta),
    lastStatus: orchestrator.getRunState(sessionId),
    updatedAt: nowIso(),
  };
}
