import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { dispatchInvoke, registerInvokeToolHandler, unregisterInvokeToolHandler } from "../src/dispatcher";
import { FsGuard } from "../src/fs-guard";
import type { BridgeConfig } from "../src/config";
import type { InvokeRequest } from "../src/types";
import { registerToolContract, unregisterToolContract } from "../src/tool-registry";
import { parseInvokeFrame } from "../src/protocol";

function createTestConfig(root: string): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "test-token",
    mode: "strict",
    enableBashExec: true,
    roots: [root],
    allowOrigins: [],
    maxOutputBytes: 64 * 1024,
    maxReadBytes: 64 * 1024,
    maxConcurrency: 4,
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 60_000,
    auditPath: path.join(root, "audit.log"),
  };
}

describe("dispatchInvoke", () => {
  test("routes read_file alias to read tool handler", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-dispatch-"));
    try {
      const filePath = path.join(root, "sample.txt");
      await writeFile(filePath, "hello-dispatch", "utf8");

      const req = parseInvokeFrame(JSON.stringify({
        id: "i1",
        type: "invoke",
        tool: "read_file",
        args: {
          path: "sample.txt",
          cwd: root,
        },
      }));
      const out = await dispatchInvoke(req, {
        config: createTestConfig(root),
        fsGuard: new FsGuard("strict", [root]),
      });

      expect(String(out.content || "")).toBe("hello-dispatch");
      expect(Number(out.size || 0)).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("supports dynamically registered canonical tool handler", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-dispatch-custom-"));
    try {
      registerToolContract({
        name: "memory.read",
        aliases: ["memory_read"]
      }, { replace: true });
      registerInvokeToolHandler(
        "memory.read",
        async (req) => ({
          source: "custom-memory",
          requestedTool: req.tool,
          canonicalTool: req.canonicalTool
        }),
        { replace: true },
      );

      const req = parseInvokeFrame(JSON.stringify({
        id: "i2",
        type: "invoke",
        tool: "memory_read",
        args: {},
      }));

      const out = await dispatchInvoke(req, {
        config: createTestConfig(root),
        fsGuard: new FsGuard("strict", [root]),
      });
      expect(String(out.source || "")).toBe("custom-memory");
      expect(String(out.requestedTool || "")).toBe("memory_read");
      expect(String(out.canonicalTool || "")).toBe("memory.read");
    } finally {
      unregisterInvokeToolHandler("memory.read");
      unregisterToolContract("memory.read");
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails fast when canonicalTool is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-dispatch-missing-canonical-"));
    try {
      const req: InvokeRequest = {
        id: "i3",
        type: "invoke",
        tool: "read_file",
        canonicalTool: "",
        args: {
          path: "sample.txt",
          cwd: root,
        },
      };
      await expect(
        dispatchInvoke(req, {
          config: createTestConfig(root),
          fsGuard: new FsGuard("strict", [root]),
        })
      ).rejects.toThrow("Unknown tool");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
