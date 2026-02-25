import "./test-setup";

import { describe, expect, it } from "vitest";
import { compact, prepareCompaction } from "../compaction.browser";
import { BrowserSessionManager } from "../session-manager.browser";

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

  it("追加 compaction 后上下文会带 previous summary", async () => {
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
      previousSummary: before.previousSummary,
      keepTail: 2,
      splitTurn: true
    });
    const draft = await compact(preparation, async () => "mock-compaction-summary");

    await manager.appendCompaction(meta.header.id, "threshold", draft);
    const after = await manager.buildSessionContext(meta.header.id);

    expect(after.previousSummary.length).toBeGreaterThan(0);
    expect(after.messages.some((msg) => msg.role === "system")).toBe(false);
  });
});
