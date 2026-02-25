import {
  appendSessionEntry,
  initSessionStorage,
  readAllSessionEntries,
  readSessionIndex,
  readSessionMeta,
  writeSessionMeta,
  type SessionIndex
} from "./session-store.browser";
import {
  nowIso,
  randomId,
  type CompactionDraft,
  type CompactionEntry,
  type MessageEntry,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
  type SessionMessageRole,
  type SessionMeta
} from "./types";

export interface CreateSessionInput {
  id?: string;
  parentSessionId?: string | null;
  cwd?: string;
  title?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  chunkSize?: number;
}

export interface AppendMessageInput {
  sessionId: string;
  role: SessionMessageRole;
  text: string;
  toolName?: string;
  toolCallId?: string;
  custom?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
}

export interface AppendCustomInput {
  sessionId: string;
  key: string;
  value: unknown;
  parentId?: string | null;
  custom?: Record<string, unknown>;
}

// 对照点：pi-mono/packages/coding-agent/src/core/session-manager.ts:307 buildSessionContext
export class BrowserSessionManager {
  private readonly writeTailBySession = new Map<string, Promise<void>>();

  private async withSessionWriteLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const key = String(sessionId || "").trim();
    const previous = this.writeTailBySession.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const nextTail = run.then(
      () => undefined,
      () => undefined
    );
    this.writeTailBySession.set(key, nextTail);
    try {
      return await run;
    } finally {
      if (this.writeTailBySession.get(key) === nextTail) {
        this.writeTailBySession.delete(key);
      }
    }
  }

  private async appendEntryUnlocked(sessionId: string, entry: SessionEntry): Promise<SessionMeta> {
    return appendSessionEntry(sessionId, entry);
  }

  async createSession(input: CreateSessionInput = {}): Promise<SessionMeta> {
    const header: SessionHeader = {
      type: "session",
      version: 1,
      id: input.id ?? randomId("session"),
      parentSessionId: input.parentSessionId ?? null,
      timestamp: nowIso(),
      cwd: input.cwd,
      title: input.title,
      model: input.model,
      metadata: input.metadata
    };
    return initSessionStorage(header, { chunkSize: input.chunkSize });
  }

  async ensureSession(sessionId: string): Promise<SessionMeta> {
    const meta = await readSessionMeta(sessionId);
    if (!meta) {
      throw new Error(`session 不存在: ${sessionId}`);
    }
    return meta;
  }

  async listSessions(): Promise<SessionIndex> {
    return readSessionIndex();
  }

  async getMeta(sessionId: string): Promise<SessionMeta | null> {
    return readSessionMeta(sessionId);
  }

  async getLeaf(sessionId: string): Promise<string | null> {
    const meta = await this.ensureSession(sessionId);
    return meta.leafId;
  }

  async setLeaf(sessionId: string, leafId: string | null): Promise<SessionMeta> {
    return this.withSessionWriteLock(sessionId, async () => {
      const meta = await this.ensureSession(sessionId);
      const next: SessionMeta = {
        ...meta,
        leafId,
        updatedAt: nowIso()
      };
      await writeSessionMeta(sessionId, next);
      return next;
    });
  }

  async appendEntry(sessionId: string, entry: SessionEntry): Promise<SessionMeta> {
    return this.withSessionWriteLock(sessionId, () => this.appendEntryUnlocked(sessionId, entry));
  }

  async appendMessage(input: AppendMessageInput): Promise<MessageEntry> {
    return this.withSessionWriteLock(input.sessionId, async () => {
      const parentId = input.parentId === undefined ? await this.getLeaf(input.sessionId) : input.parentId;
      const entry: MessageEntry = {
        id: randomId("entry"),
        type: "message",
        parentId,
        timestamp: nowIso(),
        role: input.role,
        text: input.text,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        metadata: input.metadata,
        custom: input.custom
      };
      await this.appendEntryUnlocked(input.sessionId, entry);
      return entry;
    });
  }

  async appendCustom(input: AppendCustomInput): Promise<SessionEntry> {
    return this.withSessionWriteLock(input.sessionId, async () => {
      const parentId = input.parentId === undefined ? await this.getLeaf(input.sessionId) : input.parentId;
      const entry: SessionEntry = {
        id: randomId("entry"),
        type: "custom",
        parentId,
        timestamp: nowIso(),
        key: input.key,
        value: input.value,
        custom: input.custom
      };
      await this.appendEntryUnlocked(input.sessionId, entry);
      return entry;
    });
  }

  async appendCompaction(
    sessionId: string,
    reason: "overflow" | "threshold" | "manual",
    draft: CompactionDraft,
    details?: Record<string, unknown>
  ): Promise<CompactionEntry> {
    return this.withSessionWriteLock(sessionId, async () => {
      const parentId = await this.getLeaf(sessionId);
      const entry: CompactionEntry = {
        id: randomId("entry"),
        type: "compaction",
        parentId,
        timestamp: nowIso(),
        reason,
        summary: draft.summary,
        previousSummary: draft.previousSummary,
        firstKeptEntryId: draft.firstKeptEntryId,
        tokensBefore: draft.tokensBefore,
        tokensAfter: draft.tokensAfter,
        details
      };
      await this.appendEntryUnlocked(sessionId, entry);
      return entry;
    });
  }

  async getEntries(sessionId: string): Promise<SessionEntry[]> {
    await this.ensureSession(sessionId);
    return readAllSessionEntries(sessionId);
  }

  // 对照点：pi-mono/packages/coding-agent/src/core/session-manager.ts:663 getBranch/getLeaf 组合
  async getBranch(sessionId: string, leafId?: string | null): Promise<SessionEntry[]> {
    const meta = await this.ensureSession(sessionId);
    const all = await readAllSessionEntries(sessionId);
    if (all.length === 0) return [];

    const targetLeafId = leafId === undefined ? meta.leafId : leafId;
    if (!targetLeafId) return all;

    const byId = new Map(all.map((entry) => [entry.id, entry]));
    const chain: SessionEntry[] = [];
    let cursor: SessionEntry | undefined = byId.get(targetLeafId);
    let guard = all.length + 2;

    while (cursor && guard > 0) {
      chain.push(cursor);
      guard -= 1;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }

    if (chain.length === 0) return all;
    return chain.reverse();
  }

  // 对照点：pi-mono/packages/coding-agent/src/core/session-manager.ts:307 buildSessionContext
  async buildSessionContext(sessionId: string, leafId?: string | null): Promise<SessionContext> {
    const meta = await this.ensureSession(sessionId);
    const branch = await this.getBranch(sessionId, leafId);

    let previousSummary = "";
    let firstKeptEntryId: string | null = null;

    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i];
      if (entry.type !== "compaction") continue;
      previousSummary = entry.summary;
      firstKeptEntryId = entry.firstKeptEntryId;
      break;
    }

    const postCompactionEntries = (() => {
      if (!firstKeptEntryId) return branch;
      const idx = branch.findIndex((entry) => entry.id === firstKeptEntryId);
      if (idx < 0) return [];
      return branch.slice(idx);
    })();

    const messages = [] as SessionContext["messages"];
    for (const entry of postCompactionEntries) {
      if (entry.type !== "message") continue;
      messages.push({
        role: entry.role,
        content: entry.text,
        entryId: entry.id,
        toolName: entry.toolName,
        toolCallId: entry.toolCallId
      });
    }

    return {
      sessionId,
      leafId: leafId === undefined ? meta.leafId : leafId,
      entries: branch,
      previousSummary,
      messages
    };
  }
}
