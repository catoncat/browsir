import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { kvKeys } from "../idb-storage";
import {
  disposeLifoAdapter,
  getLifoDiagnostics,
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

  it("flushes consecutive shared skill writes before another session reads references", async () => {
    await invokeLifoFrame({
      sessionId: "skill-authoring",
      tool: "write",
      args: {
        path: "mem://skills/resolve-demo/SKILL.md",
        content: "# shared skill",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });
    await invokeLifoFrame({
      sessionId: "skill-authoring",
      tool: "write",
      args: {
        path: "mem://skills/resolve-demo/references/playbook.md",
        content: "shared reference body",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    const statRefs = await invokeLifoFrame({
      sessionId: "other-session",
      tool: "stat",
      args: {
        path: "mem://skills/resolve-demo/references",
        runtime: "sandbox"
      }
    });
    const readRef = await invokeLifoFrame({
      sessionId: "other-session",
      tool: "read",
      args: {
        path: "mem://skills/resolve-demo/references/playbook.md",
        runtime: "sandbox"
      }
    });

    expect(String(statRefs.type || "")).toBe("directory");
    expect(String(readRef.content || "")).toBe("shared reference body");
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

  it("returns structured timeout results and keeps the session usable", async () => {
    const sessionId = "sess-timeout";
    const startedAt = Date.now();
    const timedOut = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["sleep 5"],
        timeoutMs: 1000,
        runtime: "sandbox"
      }
    });

    expect(Number(timedOut.exitCode)).toBe(124);
    expect(timedOut.timeoutHit).toBe(true);
    expect(String(timedOut.stderr || "")).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(3000);

    const resumed = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["echo after-timeout"],
        runtime: "sandbox"
      }
    });

    expect(Number(resumed.exitCode)).toBe(0);
    expect(String(resumed.stdout || "")).toContain("after-timeout");
  });

  it("tracks compact sandbox telemetry for flushes, coalescing, and commands", async () => {
    const sessionId = "sess-diagnostics";
    await invokeLifoFrame({
      sessionId,
      tool: "write",
      args: {
        path: "mem://diag/a.txt",
        content: "hello",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    await invokeLifoFrame({
      sessionId,
      tool: "edit",
      args: {
        path: "mem://diag/a.txt",
        edits: [{ old: "hello", new: "hello sandbox" }],
        runtime: "sandbox"
      }
    });

    await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["sleep 5"],
        timeoutMs: 1000,
        runtime: "sandbox"
      }
    });

    await invokeLifoFrame({
      sessionId,
      tool: "write",
      args: {
        path: "mem://diag/b.txt",
        content: "pending-dispose-flush",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    await disposeLifoAdapter();

    const diagnostics = getLifoDiagnostics(sessionId) as Record<string, unknown>;
    const session = (diagnostics.session || {}) as Record<string, unknown>;
    const summary = (session.summary || {}) as Record<string, unknown>;
    const recent = Array.isArray(session.recent) ? session.recent : [];

    expect(Number(summary.flushCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(summary.flushSkippedCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(summary.forcedFlushCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(summary.commandCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(summary.commandTimeoutCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(summary.lastCommandExitCode || 0)).toBe(124);
    expect(String(summary.lastFlushReason || "")).toContain("adapter.dispose");
    expect(
      recent.some((item) => String((item as Record<string, unknown>).type || "") === "flush.skipped")
    ).toBe(true);
    expect(
      recent.some((item) => String((item as Record<string, unknown>).type || "") === "command.finished")
    ).toBe(true);
  });

  it("treats /mem and mem:// as the same sandbox path", async () => {
    const sessionId = "sess-slash-mount";
    await invokeLifoFrame({
      sessionId,
      tool: "write",
      args: {
        path: "/mem/docs/slash.txt",
        content: "slash-mount",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    const readCanonical = await invokeLifoFrame({
      sessionId,
      tool: "read",
      args: {
        path: "mem://docs/slash.txt",
        runtime: "sandbox"
      }
    });
    expect(String(readCanonical.content || "")).toBe("slash-mount");

    const out = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["cat /mem/docs/slash.txt"],
        runtime: "sandbox"
      }
    });
    expect(Number(out.exitCode)).toBe(0);
    expect(String(out.stdout || "")).toContain("slash-mount");
  });

  it("supports stat/list for virtual filesystem paths", async () => {
    const sessionId = "sess-inspect";
    await invokeLifoFrame({
      sessionId,
      tool: "write",
      args: {
        path: "mem://inspect/a.txt",
        content: "hello",
        mode: "overwrite",
        runtime: "sandbox"
      }
    });

    const statOut = await invokeLifoFrame({
      sessionId,
      tool: "stat",
      args: {
        path: "mem://inspect/a.txt",
        runtime: "sandbox"
      }
    });
    expect(String(statOut.type || "")).toBe("file");
    expect(statOut.exists).toBe(true);

    const listOut = await invokeLifoFrame({
      sessionId,
      tool: "list",
      args: {
        path: "mem://inspect",
        runtime: "sandbox"
      }
    });
    expect(String(listOut.type || "")).toBe("directory");
    const entries = Array.isArray(listOut.entries) ? listOut.entries : [];
    expect(entries.map((item) => String((item as Record<string, unknown>).name || ""))).toEqual(["a.txt"]);
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

  it("persists shell state across invocations in same session", async () => {
    const sessionId = "sess-live-shell";
    const seeded = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: [
          "alias bbl='echo persisted-alias'; mkdir -p project && cd project && echo shell-state > note.txt"
        ],
        runtime: "sandbox"
      }
    });
    expect(Number(seeded.exitCode || 0)).toBe(0);

    const resumed = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["bbl && cat note.txt"],
        runtime: "sandbox"
      }
    });

    expect(Number(resumed.exitCode ?? 1)).toBe(0);
    expect(String(resumed.stdout || "")).toContain("persisted-alias");
    expect(String(resumed.stdout || "")).toContain("shell-state");
    expect(String(resumed.cwd || "")).toBe("mem://project");
  });

  it("runs simple node programs inside the sandbox", async () => {
    const sessionId = "sess-node-program";
    const out = await invokeLifoFrame({
      sessionId,
      tool: "bash",
      args: {
        cmdId: "bash.exec",
        args: ["node -e \"console.log(JSON.stringify({ ok: 1 + 1 === 2 }))\""],
        runtime: "sandbox"
      }
    });

    expect(Number(out.exitCode ?? 1)).toBe(0);
    expect(String(out.stdout || "").trim()).toBe("{\"ok\":true}");
  });
});
