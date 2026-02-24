import "./test-setup";

import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveLegacyState, initSessionIndex, resetSessionStore } from "../storage-reset.browser";
import { readSessionIndex } from "../session-store.browser";

type Store = Record<string, unknown>;

async function setStore(items: Store): Promise<void> {
  await chrome.storage.local.set(items);
}

async function getStore(): Promise<Store> {
  return (await chrome.storage.local.get(null)) as Store;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("storage-reset.browser", () => {
  it("archiveLegacyState 会归档 legacy key 并保留 session store key", async () => {
    await setStore({
      chatState: { stage: 1 },
      "runtime:planner": { enabled: true },
      "trace:legacyRun": { status: "done" },
      "trace:legacyRun:events": [{ type: "step" }],
      "session:index": {
        version: 1,
        sessions: [{ id: "s1", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" }],
        updatedAt: "2024-01-01T00:00:00.000Z"
      },
      "session:s1:meta": { ok: true },
      "trace:keep:0": [{ ok: true }],
      "archive:legacy:seed": { keep: true },
      "archive:legacy:index": ["archive:legacy:seed", "archive:legacy:seed", 1]
    });

    const result = await archiveLegacyState();

    expect(result.archiveKey).toMatch(/^archive:legacy:\d+$/);
    expect(result.archivedKeys.slice().sort()).toEqual(
      ["chatState", "runtime:planner", "trace:legacyRun", "trace:legacyRun:events"].sort()
    );
    expect(result.archivedCount).toBe(4);
    expect(result.archiveIndexSize).toBe(2);

    const all = await getStore();
    const archiveKey = result.archiveKey as string;
    const archiveRecord = all[archiveKey] as Record<string, unknown>;

    expect(archiveRecord.source).toBe("pr-5-legacy-reset");
    expect((archiveRecord.keys as string[]).slice().sort()).toEqual(result.archivedKeys.slice().sort());
    expect((archiveRecord.data as Record<string, unknown>).chatState).toEqual({ stage: 1 });

    expect(all["chatState"]).toBeUndefined();
    expect(all["runtime:planner"]).toBeUndefined();
    expect(all["trace:legacyRun"]).toBeUndefined();
    expect(all["trace:legacyRun:events"]).toBeUndefined();

    expect(all["session:index"]).toBeDefined();
    expect(all["session:s1:meta"]).toBeDefined();
    expect(all["trace:keep:0"]).toBeDefined();
    expect(all["archive:legacy:index"]).toEqual(["archive:legacy:seed", archiveKey]);
    expect(all["archive:legacy:seed"]).toEqual({ keep: true });
  });

  it("archiveLegacyState 在无 legacy key 时返回 no-op", async () => {
    await setStore({
      "session:index": { version: 1, sessions: [], updatedAt: "2024-01-01T00:00:00.000Z" },
      "session:s1:meta": { ok: true },
      "trace:keep:0": [{ ok: true }],
      "archive:legacy:index": ["archive:legacy:seed"],
      "archive:legacy:seed": { keep: true }
    });

    const result = await archiveLegacyState();

    expect(result).toEqual({
      archiveKey: null,
      archivedKeys: [],
      archivedCount: 0,
      archiveIndexSize: 1
    });

    const all = await getStore();
    expect(all["session:index"]).toBeDefined();
    expect(all["archive:legacy:index"]).toEqual(["archive:legacy:seed"]);
  });

  it("resetSessionStore 支持 includeTrace/preserveArchive 开关并重建索引", async () => {
    await setStore({
      "session:index": {
        version: 1,
        sessions: [{ id: "s1", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" }],
        updatedAt: "2024-01-01T00:00:00.000Z"
      },
      "session:s1:meta": { ok: true },
      "session:s1:entries:0": [{ id: "m1" }],
      "trace:keep:0": [{ ok: true }],
      chatState: { old: true },
      "archive:legacy:index": ["archive:legacy:old"],
      "archive:legacy:old": { payload: true },
      "safe:key": "keep"
    });

    const result = await resetSessionStore({
      includeTrace: false,
      preserveArchive: false,
      archiveLegacyBeforeReset: true
    });

    expect(result.archived?.archivedKeys).toEqual(["chatState"]);
    expect(result.archived?.archiveKey).toMatch(/^archive:legacy:\d+$/);
    expect(result.removedKeys).toContain("session:index");
    expect(result.removedKeys).toContain("session:s1:meta");
    expect(result.removedKeys).toContain("session:s1:entries:0");
    expect(result.removedKeys).toContain("archive:legacy:index");
    expect(result.removedKeys).toContain("archive:legacy:old");
    expect(result.removedKeys).toContain(result.archived?.archiveKey as string);

    const all = await getStore();
    expect(all["trace:keep:0"]).toEqual([{ ok: true }]);
    expect(all["safe:key"]).toBe("keep");
    expect(all["chatState"]).toBeUndefined();
    expect(Object.keys(all).some((key) => key === "archive:legacy:index" || key.startsWith("archive:legacy:"))).toBe(false);

    expect(result.index.version).toBe(1);
    expect(result.index.sessions).toEqual([]);
    expect(await readSessionIndex()).toEqual(result.index);
  });

  it("initSessionIndex 会清洗无效索引并持久化", async () => {
    await setStore({
      "session:index": {
        version: 999,
        sessions: [
          { id: "", createdAt: "bad", updatedAt: "bad" },
          { id: "with:colon", createdAt: "bad", updatedAt: "bad" },
          { id: " keep ", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-02T00:00:00.000Z" },
          { id: "keep", createdAt: "2024-09-01T00:00:00.000Z", updatedAt: "2024-09-02T00:00:00.000Z" },
          { id: "trimmed ", createdAt: "bad", updatedAt: "bad" },
          { id: "s2", createdAt: "bad", updatedAt: "2024-06-01T00:00:00.000Z" }
        ],
        updatedAt: "bad"
      }
    });

    const result = await initSessionIndex();

    expect(result.version).toBe(1);
    expect(result.sessions.map((entry) => entry.id)).toEqual(["trimmed", "s2", "keep"]);
    expect(result.sessions[0].id).toBe("trimmed");
    expect(result.sessions[0].createdAt).toBe(result.sessions[0].updatedAt);
    expect(Number.isNaN(Date.parse(result.sessions[0].createdAt))).toBe(false);
    expect(result.sessions[1]).toEqual({
      id: "s2",
      createdAt: result.sessions[0].createdAt,
      updatedAt: "2024-06-01T00:00:00.000Z"
    });
    expect(result.sessions[2]).toEqual({
      id: "keep",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z"
    });
    expect(result.updatedAt).toBe(result.sessions[0].createdAt);

    expect(await readSessionIndex()).toEqual(result);
  });
});
