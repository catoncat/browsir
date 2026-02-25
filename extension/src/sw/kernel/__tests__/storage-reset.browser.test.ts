import "./test-setup";

import { afterEach, describe, expect, it, vi } from "vitest";
import { initSessionIndex, resetSessionStore } from "../storage-reset.browser";
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
