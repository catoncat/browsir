import "./test-setup";

import { afterEach, describe, expect, it, vi } from "vitest";
import { initSessionIndex, resetSessionStore } from "../storage-reset.browser";
import { SESSION_INDEX_KEY, readSessionIndex } from "../session-store.browser";
import { kvSet } from "../idb-storage";

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
  it("resetSessionStore 仅重置 session store（includeTrace 可选）并重建索引", async () => {
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
      includeTrace: false
    });

    expect(result.removedCount).toBe(3);
    expect(result.removedKeys).toContain("session:index");
    expect(result.removedKeys).toContain("session:s1:meta");
    expect(result.removedKeys).toContain("session:s1:entries:0");
    expect(result.removedKeys).not.toContain("trace:keep:0");
    expect(result.removedKeys).not.toContain("archive:legacy:index");
    expect(result.removedKeys).not.toContain("archive:legacy:old");
    expect(result.removedKeys).not.toContain("chatState");

    const all = await getStore();
    expect(all["trace:keep:0"]).toEqual([{ ok: true }]);
    expect(all["safe:key"]).toBe("keep");
    expect(all["chatState"]).toEqual({ old: true });
    expect(all["archive:legacy:index"]).toEqual(["archive:legacy:old"]);
    expect(all["archive:legacy:old"]).toEqual({ payload: true });

    expect(result.index.version).toBe(1);
    expect(result.index.sessions).toEqual([]);
    expect(await readSessionIndex()).toEqual(result.index);
  });

  it("initSessionIndex 会清洗无效索引并持久化", async () => {
    await kvSet(SESSION_INDEX_KEY, {
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
