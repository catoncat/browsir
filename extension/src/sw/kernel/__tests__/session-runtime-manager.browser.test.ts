import "./test-setup";

import { describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "../browser-unix-runtime/session-runtime-manager";

interface FakeRuntime {
  sessionId: string;
  serial: number;
}

describe("session-runtime-manager.browser", () => {
  it("reuses session runtime and only flushes dirty entries", async () => {
    let now = 1_000;
    let serial = 0;
    const events: string[] = [];
    const manager = new SessionRuntimeManager<FakeRuntime>(
      {
        async create(sessionId) {
          events.push(`create:${sessionId}`);
          serial += 1;
          return {
            sessionId,
            serial
          };
        },
        async flush(sessionId, runtime, reason) {
          events.push(`flush:${sessionId}:${runtime.serial}:${reason}`);
        },
        async destroy(sessionId, runtime, reason) {
          events.push(`destroy:${sessionId}:${runtime.serial}:${reason}`);
        }
      },
      {
        now: () => now,
        idleTtlMs: 60_000,
        maxLiveSessions: 4
      }
    );

    const first = await manager.acquire("s1");
    now += 10;
    const second = await manager.acquire("s1");
    expect(second).toBe(first);

    expect(await manager.flush("s1", "clean-read")).toBe(false);
    manager.markDirty("s1");
    expect(await manager.flush("s1", "checkpoint")).toBe(true);

    expect(events).toEqual([
      "create:s1",
      "flush:s1:1:checkpoint"
    ]);
    expect(manager.listRuntimeInfo()).toEqual([
      {
        sessionId: "s1",
        createdAt: 1000,
        lastUsedAt: 1010,
        lastFlushedAt: 1010,
        dirty: false
      }
    ]);
  });

  it("flushes dirty expired runtimes before ttl disposal", async () => {
    let now = 0;
    let serial = 0;
    const events: string[] = [];
    const manager = new SessionRuntimeManager<FakeRuntime>(
      {
        async create(sessionId) {
          serial += 1;
          events.push(`create:${sessionId}`);
          return {
            sessionId,
            serial
          };
        },
        async flush(sessionId, runtime, reason) {
          events.push(`flush:${sessionId}:${runtime.serial}:${reason}`);
        },
        async destroy(sessionId, runtime, reason) {
          events.push(`destroy:${sessionId}:${runtime.serial}:${reason}`);
        }
      },
      {
        now: () => now,
        idleTtlMs: 1_000,
        maxLiveSessions: 4
      }
    );

    await manager.acquire("expired");
    manager.markDirty("expired");

    now = 1_500;
    await manager.acquire("fresh");

    expect(events).toEqual([
      "create:expired",
      "flush:expired:1:ttl:flush",
      "destroy:expired:1:ttl",
      "create:fresh"
    ]);
    expect(manager.listSessionIds()).toEqual(["fresh"]);
  });

  it("evicts least recently used runtime when capacity is exceeded", async () => {
    let now = 0;
    let serial = 0;
    const events: string[] = [];
    const manager = new SessionRuntimeManager<FakeRuntime>(
      {
        async create(sessionId) {
          serial += 1;
          events.push(`create:${sessionId}`);
          return {
            sessionId,
            serial
          };
        },
        async flush(sessionId, runtime, reason) {
          events.push(`flush:${sessionId}:${runtime.serial}:${reason}`);
        },
        async destroy(sessionId, runtime, reason) {
          events.push(`destroy:${sessionId}:${runtime.serial}:${reason}`);
        }
      },
      {
        now: () => now,
        idleTtlMs: 60_000,
        maxLiveSessions: 2
      }
    );

    await manager.acquire("s1");
    manager.markDirty("s1");

    now = 10;
    await manager.acquire("s2");

    now = 20;
    await manager.acquire("s3");

    expect(events).toEqual([
      "create:s1",
      "create:s2",
      "create:s3",
      "flush:s1:1:lru:flush",
      "destroy:s1:1:lru"
    ]);
    expect(manager.listSessionIds().sort()).toEqual(["s2", "s3"]);
  });

  it("coalesces dirty flushes until the minimum interval elapses", async () => {
    let now = 5_000;
    let serial = 0;
    const events: string[] = [];
    const manager = new SessionRuntimeManager<FakeRuntime>(
      {
        async create(sessionId) {
          serial += 1;
          events.push(`create:${sessionId}`);
          return {
            sessionId,
            serial
          };
        },
        async flush(sessionId, runtime, reason) {
          events.push(`flush:${sessionId}:${runtime.serial}:${reason}`);
        },
        async destroy(sessionId, runtime, reason) {
          events.push(`destroy:${sessionId}:${runtime.serial}:${reason}`);
        }
      },
      {
        now: () => now,
        idleTtlMs: 60_000,
        maxLiveSessions: 4
      }
    );

    await manager.acquire("burst");
    manager.markDirty("burst");
    expect(await manager.flushIfDue("burst", 750, "first")).toBe(true);

    now += 100;
    manager.markDirty("burst");
    expect(await manager.flushIfDue("burst", 750, "burst")).toBe(false);

    now += 800;
    expect(await manager.flushIfDue("burst", 750, "later")).toBe(true);

    expect(events).toEqual([
      "create:burst",
      "flush:burst:1:first",
      "flush:burst:1:later"
    ]);
  });
});
