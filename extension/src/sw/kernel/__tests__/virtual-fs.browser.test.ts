import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { getDB } from "../idb-storage";
import { frameMatchesVirtualCapability, invokeVirtualFrame, shouldRouteFrameToBrowserVfs } from "../virtual-fs.browser";

describe("virtual-fs.browser", () => {
  beforeEach(async () => {
    const db = await getDB();
    await db.clear("kv");
  });

  it("supports write/read/edit through virtual frame invoke", async () => {
    const written = await invokeVirtualFrame({
      tool: "write",
      args: {
        path: "mem://skills/demo.md",
        content: "hello world",
        mode: "overwrite"
      }
    });
    expect(String(written.path || "")).toBe("mem://skills/demo.md");

    const read = await invokeVirtualFrame({
      tool: "read",
      args: {
        path: "mem://skills/demo.md"
      }
    });
    expect(String(read.content || "")).toBe("hello world");

    const edited = await invokeVirtualFrame({
      tool: "edit",
      args: {
        path: "mem://skills/demo.md",
        edits: [{ find: "world", new: "vfs" }]
      }
    });
    expect(Boolean(edited.applied)).toBe(true);

    const readAfterEdit = await invokeVirtualFrame({
      tool: "read",
      args: {
        path: "mem://skills/demo.md"
      }
    });
    expect(String(readAfterEdit.content || "")).toBe("hello vfs");
  });

  it("supports create/append mode and read offset-limit truncation", async () => {
    await invokeVirtualFrame({
      tool: "write",
      args: {
        path: "mem://docs/mode.txt",
        content: "abc",
        mode: "create"
      }
    });

    await expect(
      invokeVirtualFrame({
        tool: "write",
        args: {
          path: "mem://docs/mode.txt",
          content: "dup",
          mode: "create"
        }
      })
    ).rejects.toThrow(/already exists/i);

    await invokeVirtualFrame({
      tool: "write",
      args: {
        path: "mem://docs/mode.txt",
        content: "def",
        mode: "append"
      }
    });

    const readLimited = await invokeVirtualFrame({
      tool: "read",
      args: {
        path: "mem://docs/mode.txt",
        offset: 1,
        limit: 3
      }
    });
    expect(String(readLimited.content || "")).toBe("bcd");
    expect(Boolean(readLimited.truncated)).toBe(true);
  });

  it("supports bash.exec in browser runtime for basic virtual fs commands", async () => {
    await invokeVirtualFrame({
      tool: "write",
      args: {
        path: "mem://docs/a.md",
        content: "A",
        mode: "overwrite"
      }
    });
    await invokeVirtualFrame({
      tool: "write",
      args: {
        path: "mem://docs/b.md",
        content: "B",
        mode: "overwrite"
      }
    });

    const ls = await invokeVirtualFrame({
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        runtime: "browser",
        args: ["ls mem://docs"]
      }
    });
    expect(String(ls.stdout || "")).toContain("a.md");
    expect(String(ls.stdout || "")).toContain("b.md");

    const cat = await invokeVirtualFrame({
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        runtime: "browser",
        args: ["cat mem://docs/a.md"]
      }
    });
    expect(String(cat.stdout || "")).toContain("A");

    const unsupported = await invokeVirtualFrame({
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        runtime: "browser",
        args: ["rm mem://docs/a.md"]
      }
    });
    expect(Number(unsupported.exitCode || 0)).toBe(1);
    expect(String(unsupported.stderr || "")).toContain("不支持命令");
  });

  it("routes frame to browser vfs by runtime/path semantics", () => {
    const readMemFrame = {
      tool: "read",
      args: {
        path: "mem://notes/todo.md"
      }
    };
    const readLocalFrame = {
      tool: "read",
      args: {
        path: "/tmp/todo.md"
      }
    };
    const bashBrowserFrame = {
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        runtime: "browser",
        args: ["ls mem://"]
      }
    };
    const readMemForcedLocal = {
      tool: "read",
      args: {
        path: "mem://notes/todo.md",
        runtime: "local"
      }
    };
    const readLocalForcedBrowser = {
      tool: "read",
      args: {
        path: "/tmp/todo.md",
        runtime: "browser"
      }
    };

    expect(frameMatchesVirtualCapability(readMemFrame, "fs.read")).toBe(true);
    expect(shouldRouteFrameToBrowserVfs(readMemFrame)).toBe(true);
    expect(shouldRouteFrameToBrowserVfs(readLocalFrame)).toBe(false);
    expect(frameMatchesVirtualCapability(bashBrowserFrame, "process.exec")).toBe(true);
    expect(shouldRouteFrameToBrowserVfs(bashBrowserFrame)).toBe(true);

    expect(shouldRouteFrameToBrowserVfs(readMemForcedLocal)).toBe(false);
    expect(shouldRouteFrameToBrowserVfs(readLocalForcedBrowser)).toBe(true);
  });

  it("rejects unsupported edit mode and unsupported tool frame", async () => {
    await invokeVirtualFrame({
      tool: "write",
      args: {
        path: "mem://docs/patch.txt",
        content: "line-a\nline-b\n",
        mode: "overwrite"
      }
    });

    await expect(
      invokeVirtualFrame({
        tool: "edit",
        args: {
          path: "mem://docs/patch.txt",
          edits: [
            {
              kind: "unified_patch",
              patch: "@@ -1,2 +1,2 @@\n-line-a\n+line-x\n line-b"
            }
          ]
        }
      })
    ).rejects.toThrow(/暂不支持 unified_patch/i);

    await expect(
      invokeVirtualFrame({
        tool: "edit",
        args: {
          path: "mem://docs/patch.txt",
          edits: [{ find: "not-exists", replace: "x" }]
        }
      })
    ).rejects.toThrow(/target not found/i);

    await expect(
      invokeVirtualFrame({
        tool: "bash",
        args: {
          cmdId: "git.status",
          args: []
        }
      })
    ).rejects.toThrow(/仅支持 cmdId=bash.exec/i);

    await expect(invokeVirtualFrame({} as Record<string, unknown>)).rejects.toThrow(/缺少 tool/i);
    await expect(
      invokeVirtualFrame({
        tool: "unknown",
        args: {}
      })
    ).rejects.toThrow(/不支持 tool/i);
  });
});
