import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { kvKeys } from "../idb-storage";
import {
  disposeLifoAdapter,
  invokeLifoFrame,
  resetLifoAdapterForTest
} from "../browser-unix-runtime/lifo-adapter";

beforeEach(async () => {
  await resetLifoAdapterForTest();
});

describe("lifo-adapter.browser", () => {
  it("supports write/read/edit in sandbox runtime", async () => {
    const sessionId = "sess-write-read-edit";
    await invokeLifoFrame({
      sessionId,
      tool: "write",
      args: {
        path: "mem://notes/todo.txt",
        content: "hello world",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    const read1 = await invokeLifoFrame({
      sessionId,
      tool: "read",
      args: {
        path: "mem://notes/todo.txt",
        runtime: "sandbox"
      }
    });
    expect(String(read1.content || "")).toBe("hello world");

    await invokeLifoFrame({
      sessionId,
      tool: "edit",
      args: {
        path: "mem://notes/todo.txt",
        edits: [{ old: "world", new: "sandbox" }],
        runtime: "sandbox"
      }
    });

    const read2 = await invokeLifoFrame({
      sessionId,
      tool: "read",
      args: {
        path: "mem://notes/todo.txt",
        runtime: "sandbox"
      }
    });
    expect(String(read2.content || "")).toBe("hello sandbox");
  });

  it("isolates files by session namespace", async () => {
    await invokeLifoFrame({
      sessionId: "s1",
      tool: "write",
      args: {
        path: "mem://same/path.txt",
        content: "from-s1",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });
    await invokeLifoFrame({
      sessionId: "s2",
      tool: "write",
      args: {
        path: "mem://same/path.txt",
        content: "from-s2",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    const s1Read = await invokeLifoFrame({
      sessionId: "s1",
      tool: "read",
      args: {
        path: "mem://same/path.txt",
        runtime: "sandbox"
      }
    });
    const s2Read = await invokeLifoFrame({
      sessionId: "s2",
      tool: "read",
      args: {
        path: "mem://same/path.txt",
        runtime: "sandbox"
      }
    });

    expect(String(s1Read.content || "")).toBe("from-s1");
    expect(String(s2Read.content || "")).toBe("from-s2");
  });

  it("persists session-scoped files across adapter disposal", async () => {
    const sessionId = "persist-s1";
    await invokeLifoFrame({
      sessionId,
      tool: "write",
      args: {
        path: "mem://notes/persist.txt",
        content: "persist-me",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    await disposeLifoAdapter();

    const read = await invokeLifoFrame({
      sessionId,
      tool: "read",
      args: {
        path: "mem://notes/persist.txt",
        runtime: "sandbox"
      }
    });
    expect(String(read.content || "")).toBe("persist-me");
  });

  it("shares mem://skills across sessions", async () => {
    await invokeLifoFrame({
      sessionId: "skill-authoring",
      tool: "write",
      args: {
        path: "mem://skills/demo/SKILL.md",
        content: "# shared skill",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    await disposeLifoAdapter();

    const read = await invokeLifoFrame({
      sessionId: "other-session",
      tool: "read",
      args: {
        path: "mem://skills/demo/SKILL.md",
        runtime: "sandbox"
      }
    });
    expect(String(read.content || "")).toBe("# shared skill");
  });

  it("rejects path traversal across session roots", async () => {
    await invokeLifoFrame({
      sessionId: "s2",
      tool: "write",
      args: {
        path: "mem://safe/only-s2.txt",
        content: "only-s2",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    await expect(
      invokeLifoFrame({
        sessionId: "s1",
        tool: "read",
        args: {
          path: "mem://../../s2/mem/safe/only-s2.txt",
          runtime: "sandbox"
        }
      })
    ).rejects.toThrow("越界");
  });

  it("supports bash.exec with virtual uri rewrite", async () => {
    const sessionId = "sess-bash";
    await invokeLifoFrame({
      sessionId,
      tool: "write",
      args: {
        path: "mem://run/a.txt",
        content: "line-1",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    const out = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["cat mem://run/a.txt"],
        runtime: "sandbox"
      }
    });

    expect(Number(out.exitCode)).toBe(0);
    expect(String(out.stdout || "")).toContain("line-1");
  });

  it("keeps mem://__bbl only in memory across sandbox invocations", async () => {
    const sessionId = "sess-system-namespace";
    await invokeLifoFrame({
      sessionId,
      tool: "write",
      args: {
        path: "mem://__bbl/plugin-host-runner.cjs",
        content: "module.exports = 1;",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    const readBeforeDispose = await invokeLifoFrame({
      sessionId,
      tool: "read",
      args: {
        path: "mem://__bbl/plugin-host-runner.cjs",
        runtime: "sandbox"
      }
    });
    expect(String(readBeforeDispose.content || "")).toBe("module.exports = 1;");

    const keys = await kvKeys();
    expect(
      keys.some((key) => String(key || "").includes("__bbl"))
    ).toBe(false);

    await disposeLifoAdapter();

    await expect(
      invokeLifoFrame({
        sessionId,
        tool: "read",
        args: {
          path: "mem://__bbl/plugin-host-runner.cjs",
          runtime: "sandbox"
        }
      })
    ).rejects.toThrow("virtual file not found");
  });

  it("does not persist shell aliases across invocations in same session", async () => {
    const sessionId = "sess-no-shell-pollution";
    const aliasSet = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["alias whoami='node -e \"console.log(window)\"'"],
        runtime: "sandbox"
      }
    });
    expect(Number(aliasSet.exitCode || 0)).toBe(0);

    const whoami = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["whoami"],
        runtime: "sandbox"
      }
    });

    expect(Number(whoami.exitCode ?? 1)).toBe(0);
    expect(String(whoami.stdout || "")).toContain("user");
    expect(String(whoami.stderr || "")).not.toContain("window is not defined");
  });
});
