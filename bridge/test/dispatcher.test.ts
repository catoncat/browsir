import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { dispatchInvoke, registerInvokeToolHandler, unregisterInvokeToolHandler } from "../src/dispatcher";
import { FsGuard } from "../src/fs-guard";
import type { BridgeConfig } from "../src/config";
import type { InvokeRequest } from "../src/types";
import { registerToolContract, unregisterToolContract } from "../src/tool-registry";
import { parseInvokeFrame } from "../src/protocol";
import { resetMcpClientRegistryForTest } from "../src/mcp/client-registry";

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
    diagnosticsPath: path.join(root, "diagnostics"),
  };
}

describe("dispatchInvoke", () => {
  test("lists tools from a stdio MCP server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-dispatch-mcp-list-"));
    const fixturePath = new URL("./fixtures/mcp-echo-server.ts", import.meta.url).pathname;
    try {
      const req = parseInvokeFrame(
        JSON.stringify({
          id: "mcp-list-1",
          type: "invoke",
          tool: "mcp_list_tools",
          args: {
            server: {
              id: "fixture-stdio",
              transport: "stdio",
              command: process.execPath,
              args: [fixturePath],
              cwd: root,
            },
          },
        }),
      );

      const out = await dispatchInvoke(req, {
        config: createTestConfig(root),
        fsGuard: new FsGuard("strict", [root]),
      });

      expect(String(out.serverId || "")).toBe("fixture-stdio");
      const tools = Array.isArray(out.tools) ? out.tools : [];
      expect(
        tools.map((item) => String((item as Record<string, unknown>).name || "")),
      ).toEqual(["echo", "sum"]);
      expect(String(((tools[0] as Record<string, unknown>).title) || "")).toBe(
        "Echo Tool",
      );
    } finally {
      await resetMcpClientRegistryForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("calls a tool on a stdio MCP server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-dispatch-mcp-call-"));
    const fixturePath = new URL("./fixtures/mcp-echo-server.ts", import.meta.url).pathname;
    try {
      const req = parseInvokeFrame(
        JSON.stringify({
          id: "mcp-call-1",
          type: "invoke",
          tool: "mcp_call_tool",
          args: {
            server: {
              id: "fixture-stdio",
              transport: "stdio",
              command: process.execPath,
              args: [fixturePath],
              cwd: root,
            },
            toolName: "echo",
            arguments: {
              text: "hello-mcp",
            },
          },
        }),
      );

      const out = await dispatchInvoke(req, {
        config: createTestConfig(root),
        fsGuard: new FsGuard("strict", [root]),
      });

      expect(String(out.serverId || "")).toBe("fixture-stdio");
      expect(String(out.toolName || "")).toBe("echo");
      expect(Boolean(out.isError)).toBe(false);
      const content = Array.isArray(out.content) ? out.content : [];
      expect(
        content.some(
          (item) =>
            String((item as Record<string, unknown>).type || "") === "text" &&
            String((item as Record<string, unknown>).text || "") ===
              "echo:hello-mcp",
        ),
      ).toBe(true);
      expect((out.structuredContent as Record<string, unknown>).echoed).toBe(
        "hello-mcp",
      );
    } finally {
      await resetMcpClientRegistryForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes canonical read tool to read handler", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-dispatch-"));
    try {
      const filePath = path.join(root, "sample.txt");
      await writeFile(filePath, "hello-dispatch", "utf8");

      const req = parseInvokeFrame(JSON.stringify({
        id: "i1",
        type: "invoke",
        tool: "read",
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
        tool: " memory.read ",
        args: {},
      }));

      const out = await dispatchInvoke(req, {
        config: createTestConfig(root),
        fsGuard: new FsGuard("strict", [root]),
      });
      expect(String(out.source || "")).toBe("custom-memory");
      expect(String(out.requestedTool || "")).toBe("memory.read");
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
        tool: "read",
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

  test("routes stat tool and reports missing/file/directory metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-dispatch-stat-"));
    try {
      await mkdir(path.join(root, "nested"), { recursive: true });
      await writeFile(path.join(root, "nested", "demo.txt"), "hello", "utf8");

      const statFile = parseInvokeFrame(JSON.stringify({
        id: "s1",
        type: "invoke",
        tool: "stat",
        args: {
          path: "nested/demo.txt",
          cwd: root,
        },
      }));
      const statDir = parseInvokeFrame(JSON.stringify({
        id: "s2",
        type: "invoke",
        tool: "stat",
        args: {
          path: "nested",
          cwd: root,
        },
      }));
      const statMissing = parseInvokeFrame(JSON.stringify({
        id: "s3",
        type: "invoke",
        tool: "stat",
        args: {
          path: "nested/missing.txt",
          cwd: root,
        },
      }));

      const ctx = {
        config: createTestConfig(root),
        fsGuard: new FsGuard("strict", [root]),
      };
      const fileOut = await dispatchInvoke(statFile, ctx);
      const dirOut = await dispatchInvoke(statDir, ctx);
      const missingOut = await dispatchInvoke(statMissing, ctx);

      expect(fileOut.type).toBe("file");
      expect(fileOut.exists).toBe(true);
      expect(Number(fileOut.size || 0)).toBeGreaterThan(0);
      expect(dirOut.type).toBe("directory");
      expect(dirOut.exists).toBe(true);
      expect(missingOut.type).toBe("missing");
      expect(missingOut.exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes list tool and returns shallow directory entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-dispatch-list-"));
    try {
      await mkdir(path.join(root, "nested", "child"), { recursive: true });
      await writeFile(path.join(root, "nested", "a.txt"), "a", "utf8");
      await writeFile(path.join(root, "nested", "child", "b.txt"), "b", "utf8");

      const req = parseInvokeFrame(JSON.stringify({
        id: "l1",
        type: "invoke",
        tool: "list",
        args: {
          path: "nested",
          cwd: root,
        },
      }));
      const out = await dispatchInvoke(req, {
        config: createTestConfig(root),
        fsGuard: new FsGuard("strict", [root]),
      });

      expect(out.type).toBe("directory");
      expect(out.exists).toBe(true);
      const entries = Array.isArray(out.entries) ? out.entries : [];
      expect(entries.map((item) => String((item as Record<string, unknown>).name || ""))).toEqual(["child", "a.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
