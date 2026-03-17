import "./test-setup";

import { describe, expect, it } from "vitest";
import { compact, prepareCompaction } from "../compaction.browser";
import { BrowserSessionManager } from "../session-manager.browser";
import { getDB } from "../idb-storage";

describe("session-manager.browser", () => {
  it("可以创建会话并构建上下文", async () => {
    const manager = new BrowserSessionManager();
    const meta = await manager.createSession({ title: "demo" });

    await manager.appendMessage({
      sessionId: meta.header.id,
      role: "user",
      text: "你好"
    });
    await manager.appendMessage({
      sessionId: meta.header.id,
      role: "assistant",
      text: "你好，我在。"
    });

    const context = await manager.buildSessionContext(meta.header.id);
    expect(context.messages.length).toBe(2);
    expect(context.messages[0].role).toBe("user");
    expect(context.messages[1].role).toBe("assistant");
  });

  it("追加 compaction 后上下文会带 compaction summary 消息", async () => {
    const manager = new BrowserSessionManager();
    const meta = await manager.createSession({ title: "with-compaction" });

    await manager.appendMessage({ sessionId: meta.header.id, role: "user", text: "Q1" });
    await manager.appendMessage({ sessionId: meta.header.id, role: "assistant", text: "A1" });
    await manager.appendMessage({ sessionId: meta.header.id, role: "user", text: "Q2" });
    await manager.appendMessage({ sessionId: meta.header.id, role: "assistant", text: "A2" });

    const before = await manager.buildSessionContext(meta.header.id);
    const preparation = prepareCompaction({
      reason: "threshold",
      entries: before.entries,
      keepRecentTokens: 2,
      splitTurn: true
    });
    const draft = await compact(preparation, async () => "mock-compaction-summary");

    await manager.appendCompaction(meta.header.id, "threshold", draft);
    const after = await manager.buildSessionContext(meta.header.id);

    expect(after.messages[0]?.role).toBe("compactionSummary");
    expect(after.messages[0]?.content).toContain("mock-compaction-summary");
    expect(after.messages.some((msg) => msg.role === "system")).toBe(false);
  });

  it("新建 session 只接受 workingContext，并忽略废弃 cwd 字段", async () => {
    const manager = new BrowserSessionManager();
    const created = await manager.createSession({
      title: "with-working-context",
      workingContext: {
        hostCwd: "/Users/demo/project",
        browserCwd: "mem://",
        browserUserMount: "/mem",
      },
    });
    expect(created.header.workingContext?.browserCwd).toBe("mem://");
    expect(created.header.workingContext?.browserUserMount).toBe("/mem");
    expect(created.header.workingContext?.hostCwd).toBe("/Users/demo/project");

    const db = await getDB();
    await db.put("sessions", {
      header: {
        type: "session",
        version: 1,
        id: "obsolete-cwd-session",
        parentSessionId: null,
        timestamp: "2024-01-01T00:00:00.000Z",
        cwd: "/tmp/obsolete-cwd",
      },
      leafId: null,
      entryCount: 0,
      chunkCount: 1,
      chunkSize: 999999,
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const stored = await manager.getMeta("obsolete-cwd-session");
    expect(stored?.header.workingContext?.hostCwd).toBeUndefined();
    expect(stored?.header.workingContext?.browserCwd).toBe("mem://");
  });

  it("updateMeta 与 appendMessage 并发时应保留标题和 entryCount", async () => {
    const manager = new BrowserSessionManager();
    const created = await manager.createSession({ title: "新对话" });
    const sessionId = created.header.id;

    await manager.appendMessage({
      sessionId,
      role: "user",
      text: "第一条消息",
    });

    await Promise.all([
      manager.updateMeta(sessionId, (meta) => ({
        ...meta,
        header: {
          ...meta.header,
          title: "自动标题",
        },
      })),
      manager.appendMessage({
        sessionId,
        role: "assistant",
        text: "第二条消息",
      }),
    ]);

    const meta = await manager.getMeta(sessionId);
    expect(meta?.header.title).toBe("自动标题");
    expect(meta?.entryCount).toBe(2);
    expect(String(meta?.leafId || "")).not.toBe("");
  });
});
