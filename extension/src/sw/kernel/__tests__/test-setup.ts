import "fake-indexeddb/auto";
import { beforeEach } from "vitest";

type Store = Record<string, unknown>;

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function createStorageArea() {
  let store: Store = {};

  return {
    async get(keys?: string | string[] | null) {
      if (keys === null || keys === undefined) return clone(store);
      if (typeof keys === "string") return { [keys]: clone(store[keys]) };
      const out: Store = {};
      for (const key of keys) out[key] = clone(store[key]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      store = { ...store, ...clone(items) };
    },
    async remove(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        delete store[key];
      }
    },
    async clear() {
      store = {};
    }
  };
}

beforeEach(() => {
  const storageLocal = createStorageArea();

  (globalThis as any).chrome = {
    storage: {
      local: storageLocal
    },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async () => ({ ok: true })
    },
    sidePanel: {
      open: async () => {}
    },
    action: {
      onClicked: { addListener() {} }
    }
  };
});
