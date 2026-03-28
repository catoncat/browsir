import { describe, expect, it } from "vitest";
import { compact, findCutPoint, prepareCompaction, shouldCompact } from "../compaction.browser";
import type { SessionEntry } from "../types";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../shared/compaction";

function message(id: string, role: "user" | "assistant", text: string, parentId: string | null): SessionEntry {
  return {
    id,
    type: "message",
    role,
    text,
    parentId,
    timestamp: new Date().toISOString()
  };
}

function toolMessage(
  id: string,
  toolName: string,
  payload: Record<string, unknown>,
  parentId: string | null
): SessionEntry {
  return {
    id,
    type: "message",
    role: "tool",
    text: JSON.stringify(payload),
    toolName,
    parentId,
    timestamp: new Date().toISOString()
  };
}

function compactionEntry(
  id: string,
  summary: string,
  firstKeptEntryId: string | null,
  parentId: string | null
): SessionEntry {
  return {
    id,
    type: "compaction",
    reason: "threshold",
    summary,
    firstKeptEntryId,
    previousSummary: "",
    tokensBefore: 100,
    tokensAfter: 40,
    parentId,
    timestamp: new Date().toISOString()
  };
}

const eagerCompactionSettings = {
  ...DEFAULT_COMPACTION_SETTINGS,
  contextWindowTokens: 1,
  reserveTokens: 1,
  keepRecentTokens: 2
};

describe("compaction.browser", () => {
  it("overflow 时必须触发 compaction", () => {
    const entries = [
      message("a", "user", "hello", null),
      message("b", "assistant", "world", "a")
    ];
    const result = shouldCompact({
      overflow: true,
      entries,
      settings: eagerCompactionSettings
    });
    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toBe("overflow");
  });

  it("split-turn 会把 cut 对齐到用户消息", () => {
    const entries = [
      message("u1", "user", "first", null),
      message("a1", "assistant", "answer1", "u1"),
      message("u2", "user", "second", "a1"),
      message("a2", "assistant", "answer2", "u2")
    ];
    const cut = findCutPoint({ entries, keepRecentTokens: 8, splitTurn: true });
    expect(cut.firstKeptEntryId).toBe("u2");
  });

  it("prepareCompaction 返回 kept/dropped 和 draft", () => {
    const entries = [
      message("u1", "user", "first", null),
      message("a1", "assistant", "answer1", "u1"),
      message("u2", "user", "second", "a1"),
      message("a2", "assistant", "answer2", "u2")
    ];
    const draft = prepareCompaction({
      reason: "threshold",
      entries,
      keepRecentTokens: 8,
      splitTurn: true
    });

    expect(draft.previousSummary).toBe("");
    expect(draft.keptEntries.length).toBeGreaterThan(0);
    expect(draft.droppedEntries.length).toBeGreaterThan(0);
    expect(draft.firstKeptEntryId).toBe("u2");
    expect(draft.tokensBefore).toBeGreaterThan(0);
    expect(draft.tokensAfter).toBeGreaterThan(0);
  });

  it("compact 通过 summary generator 生成最终摘要", async () => {
    const entries = [
      compactionEntry("c1", "old-summary", "u1", null),
      message("u1", "user", "first", null),
      message("a1", "assistant", "answer1", "u1"),
      message("u2", "user", "second", "a1"),
      message("a2", "assistant", "answer2", "u2")
    ];
    const preparation = prepareCompaction({
      reason: "threshold",
      entries,
      keepRecentTokens: 1,
      splitTurn: true
    });
    const draft = await compact(preparation, async (input) => {
      if (input.mode === "turn_prefix") return "turn-prefix-summary";
      return "history-summary";
    });

    expect(draft.summary).toContain("history-summary");
    expect(draft.summary).toContain("turn-prefix-summary");
    expect(draft.tokensAfter).toBeGreaterThan(0);
  });

  it("split-turn 摘要请求必须串行，避免同 session compaction lane 并发", async () => {
    const entries = [
      compactionEntry("c1", "old-summary", "u1", null),
      message("u1", "user", "first", null),
      message("a1", "assistant", "answer1", "u1"),
      message("u2", "user", "second", "a1"),
      message("a2", "assistant", "answer2", "u2")
    ];
    const preparation = prepareCompaction({
      reason: "threshold",
      entries,
      keepRecentTokens: 1,
      splitTurn: true
    });
    let inflight = 0;
    let maxInflight = 0;

    await compact(preparation, async (input) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await Promise.resolve();
      inflight -= 1;
      return input.mode === "turn_prefix" ? "turn-prefix-summary" : "history-summary";
    });

    expect(maxInflight).toBe(1);
  });

  it("compact 会从 host_/browser_ 文件工具结果提取 read/modified 文件清单", async () => {
    const entries: SessionEntry[] = [
      message("u1", "user", "先读再改", null),
      toolMessage("t1", "host_read_file", { tool: "host_read_file", args: { path: "/tmp/a.txt" } }, "u1"),
      toolMessage("t2", "browser_edit_file", { tool: "browser_edit_file", args: { path: "mem://note.md" } }, "t1"),
      message("u2", "user", "继续", "t2")
    ];

    const preparation = prepareCompaction({
      reason: "threshold",
      entries,
      keepRecentTokens: 1,
      splitTurn: false
    });
    const draft = await compact(preparation, async () => "summary");

    expect(draft.summary).toContain("<read-files>");
    expect(draft.summary).toContain("/tmp/a.txt");
    expect(draft.summary).toContain("<modified-files>");
    expect(draft.summary).toContain("mem://note.md");
  });

  it("空 compaction 直接 no-op，不会触发摘要请求", async () => {
    const entries: SessionEntry[] = [
      compactionEntry("c1", "existing-summary", "u2", null),
      message("u1", "user", "old", null),
      message("a1", "assistant", "old-answer", "u1"),
      message("u2", "user", "recent", "a1"),
      message("a2", "assistant", "recent-answer", "u2")
    ];
    const preparation = prepareCompaction({
      reason: "threshold",
      entries,
      keepRecentTokens: 9999,
      splitTurn: true
    });

    let called = false;
    const draft = await compact(preparation, async () => {
      called = true;
      return "should-not-run";
    });

    expect(preparation.isNoOp).toBe(true);
    expect(called).toBe(false);
    expect(draft.summary).toBe("existing-summary");
    expect(draft.droppedEntries).toHaveLength(0);
  });

  it("摘要 prompt 会裁剪超长消息，避免把整段历史原文塞给模型", async () => {
    const longText = [
      "HEAD-0",
      ...Array.from({ length: 5000 }, (_, index) => `body-${index}`),
      "TAIL-4999"
    ].join("\n");
    const entries: SessionEntry[] = [
      message("u1", "user", longText, null),
      message("a1", "assistant", "收到", "u1"),
      message("u2", "user", "继续", "a1")
    ];

    const preparation = prepareCompaction({
      reason: "threshold",
      entries,
      keepRecentTokens: 1,
      splitTurn: false
    });

    let promptText = "";
    await compact(preparation, async (input) => {
      promptText = input.promptText;
      return "summary";
    });

    expect(promptText).toContain("HEAD-0");
    expect(promptText).toContain("TAIL-4999");
    expect(promptText).toContain("[truncated ");
    expect(promptText).not.toContain("body-2500");
    expect(promptText.length).toBeLessThan(longText.length);
  });
});
