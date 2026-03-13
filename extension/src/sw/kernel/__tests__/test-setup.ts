import "fake-indexeddb/auto";
import { beforeEach } from "vitest";
import type { Sandbox } from "@lifo-sh/core";
import { _setTestBashExecutor } from "../browser-unix-runtime/lifo-adapter";

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
      sendMessage: async () => ({ ok: true }),
      getContexts: async () => []
    },
    offscreen: {
      createDocument: async () => {}
    },
    sidePanel: {
      open: async () => {}
    },
    action: {
      onClicked: { addListener() {} }
    }
  };

  // Install direct LIFO executor for tests (no sandbox page relay needed)
  _setTestBashExecutor(async (sandbox: Sandbox, command: string, cwd: string | undefined, timeoutMs?: number) => {
    const processRegistry = sandbox.shell.getProcessRegistry();
    const baselinePids = new Set(processRegistry.getAllPIDs());
    let timeoutHit = false;

    const options = cwd != null ? { cwd } : {};
    const pending = sandbox.commands.run(command, options);
    const timer = timeoutMs == null ? null : setTimeout(() => {
      timeoutHit = true;
      for (const row of processRegistry.getAll()) {
        if (baselinePids.has(row.pid)) continue;
        processRegistry.kill(row.pid, "SIGTERM");
      }
    }, timeoutMs);

    try {
      const result = await pending;
      if (timer != null) clearTimeout(timer);

      if (timeoutHit) {
        const stderr = String(result.stderr || "").trim();
        const msg = `sandbox bash timed out`;
        return {
          ok: false, stdout: String(result.stdout || ""),
          stderr: stderr ? `${stderr}\n${msg}` : msg,
          exitCode: 124, vfsDiff: [],
        };
      }

      return {
        ok: Number(result.exitCode ?? 0) === 0,
        stdout: String(result.stdout || ""),
        stderr: String(result.stderr || ""),
        exitCode: Number(result.exitCode ?? 0),
        vfsDiff: [],
      };
    } catch (err) {
      if (timer != null) clearTimeout(timer);
      return {
        ok: false, stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1, vfsDiff: [],
      };
    }
  });
});
