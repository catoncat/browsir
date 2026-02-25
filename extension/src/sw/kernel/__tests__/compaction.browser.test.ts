import { describe, expect, it } from "vitest";
import { compact, findCutPoint, prepareCompaction, shouldCompact } from "../compaction.browser";
import type { SessionEntry } from "../types";

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

describe("compaction.browser", () => {
  it("overflow 时必须触发 compaction", () => {
    const entries = [
      message("a", "user", "hello", null),
      message("b", "assistant", "world", "a")
    ];
    const result = shouldCompact({
      overflow: true,
      entries,
      previousSummary: "",
      thresholdTokens: 999999
    });
    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toBe("overflow");
  });

  it("split-turn 会把 cut 对齐到用户消息", () => {
    const entries = [
      message("u1", "user", "q1", null),
      message("a1", "assistant", "a1", "u1"),
      message("u2", "user", "q2", "a1"),
      message("a2", "assistant", "a2", "u2")
    ];
    const cut = findCutPoint({ entries, keepTail: 2, splitTurn: true });
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
      previousSummary: "old-summary",
      keepTail: 2,
      splitTurn: true
    });

    expect(draft.previousSummary).toContain("old-summary");
    expect(draft.keptEntries.length).toBeGreaterThan(0);
    expect(draft.droppedEntries.length).toBeGreaterThan(0);
    expect(draft.firstKeptEntryId).toBe("u2");
    expect(draft.tokensBefore).toBeGreaterThan(0);
    expect(draft.tokensAfter).toBeGreaterThan(0);
  });

  it("compact 通过 summary generator 生成最终摘要", async () => {
    const entries = [
      message("u1", "user", "first", null),
      message("a1", "assistant", "answer1", "u1"),
      message("u2", "user", "second", "a1"),
      message("a2", "assistant", "answer2", "u2")
    ];
    const preparation = prepareCompaction({
      reason: "threshold",
      entries,
      previousSummary: "old-summary",
      keepTail: 1,
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
});
