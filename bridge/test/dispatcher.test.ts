import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { dispatchInvoke } from "../src/dispatcher";
import { FsGuard } from "../src/fs-guard";
import type { BridgeConfig } from "../src/config";
import type { InvokeRequest } from "../src/types";

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

      const req: InvokeRequest = {
        id: "i1",
        type: "invoke",
        tool: "read_file",
        canonicalTool: "",
        args: {
          path: "sample.txt",
          cwd: root,
        },
      };
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
});

