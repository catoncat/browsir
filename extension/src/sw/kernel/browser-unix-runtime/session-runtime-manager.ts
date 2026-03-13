export interface SessionRuntimeManagerHooks<T> {
  create(sessionId: string): Promise<T>;
  flush(sessionId: string, runtime: T, reason: string): Promise<void>;
  destroy(sessionId: string, runtime: T, reason: string): Promise<void>;
}

export interface SessionRuntimeManagerOptions {
  idleTtlMs?: number;
  maxLiveSessions?: number;
  now?: () => number;
}

interface SessionRuntimeEntry<T> {
  runtime: T;
  createdAt: number;
  lastUsedAt: number;
  lastFlushedAt: number | null;
  dirty: boolean;
}

export interface SessionRuntimeInfo {
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
  lastFlushedAt: number | null;
  dirty: boolean;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_LIVE_SESSIONS = 8;

export class SessionRuntimeManager<T> {
  private readonly hooks: SessionRuntimeManagerHooks<T>;
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private readonly maxLiveSessions: number;
  private readonly entries = new Map<string, SessionRuntimeEntry<T>>();

  constructor(
    hooks: SessionRuntimeManagerHooks<T>,
    options: SessionRuntimeManagerOptions = {}
  ) {
    this.hooks = hooks;
    this.now = options.now ?? (() => Date.now());
    this.idleTtlMs = Math.max(1_000, Number(options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS));
    this.maxLiveSessions = Math.max(
      1,
      Math.floor(Number(options.maxLiveSessions ?? DEFAULT_MAX_LIVE_SESSIONS))
    );
  }

  listSessionIds(): string[] {
    return [...this.entries.keys()];
  }

  listRuntimeInfo(): SessionRuntimeInfo[] {
    return [...this.entries.entries()]
      .map(([sessionId, entry]) => ({
        sessionId,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        lastFlushedAt: entry.lastFlushedAt,
        dirty: entry.dirty
      }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  getRuntimeInfo(sessionId: string): SessionRuntimeInfo | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return {
      sessionId,
      createdAt: entry.createdAt,
      lastUsedAt: entry.lastUsedAt,
      lastFlushedAt: entry.lastFlushedAt,
      dirty: entry.dirty
    };
  }

  async acquire(sessionId: string): Promise<T> {
    await this.reapExpired();
    const now = this.now();
    let entry = this.entries.get(sessionId);
    if (!entry) {
      const runtime = await this.hooks.create(sessionId);
      entry = {
        runtime,
        createdAt: now,
        lastUsedAt: now,
        lastFlushedAt: null,
        dirty: false
      };
      this.entries.set(sessionId, entry);
      await this.reapToCapacity(sessionId);
      return runtime;
    }
    entry.lastUsedAt = now;
    return entry.runtime;
  }

  markDirty(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.dirty = true;
    entry.lastUsedAt = this.now();
  }

  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.lastUsedAt = this.now();
  }

  async flush(sessionId: string, reason = "manual"): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.dirty !== true) return false;
    await this.hooks.flush(sessionId, entry.runtime, reason);
    entry.dirty = false;
    entry.lastUsedAt = this.now();
    entry.lastFlushedAt = entry.lastUsedAt;
    return true;
  }

  async flushIfDue(
    sessionId: string,
    minIntervalMs: number,
    reason = "manual"
  ): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.dirty !== true) return false;
    const minInterval = Math.max(0, Math.floor(Number(minIntervalMs || 0)));
    if (entry.lastFlushedAt != null && this.now() - entry.lastFlushedAt < minInterval) {
      entry.lastUsedAt = this.now();
      return false;
    }
    return await this.flush(sessionId, reason);
  }

  async flushAll(reason = "manual"): Promise<string[]> {
    const flushed: string[] = [];
    for (const sessionId of this.entries.keys()) {
      if (await this.flush(sessionId, reason)) {
        flushed.push(sessionId);
      }
    }
    return flushed;
  }

  async dispose(
    sessionId: string,
    options: { flushDirty?: boolean; reason?: string } = {}
  ): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    const flushDirty = options.flushDirty ?? true;
    const reason = String(options.reason || "manual");
    this.entries.delete(sessionId);
    try {
      if (flushDirty && entry.dirty) {
        await this.hooks.flush(sessionId, entry.runtime, `${reason}:flush`);
        entry.lastFlushedAt = this.now();
        entry.dirty = false;
      }
    } finally {
      await this.hooks.destroy(sessionId, entry.runtime, reason);
    }
    return true;
  }

  async disposeAll(
    options: { flushDirty?: boolean; reason?: string } = {}
  ): Promise<string[]> {
    const disposed: string[] = [];
    for (const sessionId of [...this.entries.keys()]) {
      await this.dispose(sessionId, options);
      disposed.push(sessionId);
    }
    return disposed;
  }

  async reapExpired(reason = "ttl"): Promise<string[]> {
    const now = this.now();
    const expired = [...this.entries.entries()]
      .filter(([, entry]) => now - entry.lastUsedAt >= this.idleTtlMs)
      .map(([sessionId]) => sessionId);
    for (const sessionId of expired) {
      await this.dispose(sessionId, {
        flushDirty: true,
        reason
      });
    }
    return expired;
  }

  private async reapToCapacity(preserveSessionId: string): Promise<void> {
    while (this.entries.size > this.maxLiveSessions) {
      const candidate = this.findLruVictim(preserveSessionId);
      if (!candidate) return;
      await this.dispose(candidate, {
        flushDirty: true,
        reason: "lru"
      });
    }
  }

  private findLruVictim(preserveSessionId: string): string | null {
    let victim: { sessionId: string; lastUsedAt: number } | null = null;
    for (const [sessionId, entry] of this.entries.entries()) {
      if (sessionId === preserveSessionId && this.entries.size > 1) continue;
      if (!victim || entry.lastUsedAt < victim.lastUsedAt) {
        victim = {
          sessionId,
          lastUsedAt: entry.lastUsedAt
        };
      }
    }
    return victim?.sessionId ?? null;
  }
}
