import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  calculateActionSignature,
  isNoProgress,
  updateProgressBudget,
  normalizeNoProgressEvidenceValue,
  buildNoProgressEvidenceFingerprint,
  buildNoProgressScopeKey,
  resolveNoProgressDecision,
} from "../loop-progress-guard";

describe("loop-progress-guard", () => {
  describe("calculateActionSignature", () => {
    it("builds a deterministic signature from action + args", () => {
      const sig = calculateActionSignature("click", { uid: "btn-1", x: 10 });
      expect(sig).toContain("click");
      expect(sig).toContain("uid");
    });

    it("produces same signature for same input", () => {
      const a = calculateActionSignature("fill", { uid: "input-1", value: "hi" });
      const b = calculateActionSignature("fill", { uid: "input-1", value: "hi" });
      expect(a).toBe(b);
    });

    it("sorts args keys for stability", () => {
      const a = calculateActionSignature("click", { z: 1, a: 2 });
      const b = calculateActionSignature("click", { a: 2, z: 1 });
      expect(a).toBe(b);
    });
  });

  describe("isNoProgress", () => {
    it("returns false for empty history", () => {
      expect(isNoProgress([], { actionSignature: "a", evidenceHash: "h", timestamp: "" })).toBe(false);
    });

    it("detects repeated signature+evidence as no-progress", () => {
      const history = [{ actionSignature: "click|uid:btn", evidenceHash: "abc", timestamp: "t1" }];
      expect(isNoProgress(history, { actionSignature: "click|uid:btn", evidenceHash: "abc", timestamp: "t2" })).toBe(true);
    });

    it("returns false when evidence changes", () => {
      const history = [{ actionSignature: "click|uid:btn", evidenceHash: "abc", timestamp: "t1" }];
      expect(isNoProgress(history, { actionSignature: "click|uid:btn", evidenceHash: "def", timestamp: "t2" })).toBe(false);
    });
  });

  describe("updateProgressBudget", () => {
    it("decrements on no-progress", () => {
      expect(updateProgressBudget(3, true)).toBe(2);
    });

    it("does not go below zero", () => {
      expect(updateProgressBudget(0, true)).toBe(0);
    });

    it("keeps budget unchanged on progress", () => {
      expect(updateProgressBudget(3, false)).toBe(3);
    });
  });

  describe("normalizeNoProgressEvidenceValue", () => {
    it("strips volatile keys from objects", () => {
      const result = normalizeNoProgressEvidenceValue({
        action: "click",
        tabId: 123,
        sessionId: "s1",
        uid: "u1",
        target: "btn",
      });
      expect(result).toEqual({ action: "click", target: "btn" });
    });

    it("truncates long strings", () => {
      const long = "x".repeat(500);
      const result = normalizeNoProgressEvidenceValue(long) as string;
      expect(result.length).toBeLessThan(500);
    });

    it("truncates long arrays", () => {
      const arr = Array.from({ length: 20 }, (_, i) => i);
      const result = normalizeNoProgressEvidenceValue(arr) as unknown[];
      expect(result.length).toBe(9); // 8 items + truncation marker
      expect(result[8]).toContain("__truncated__");
    });

    it("passes through primitives", () => {
      expect(normalizeNoProgressEvidenceValue(42)).toBe(42);
      expect(normalizeNoProgressEvidenceValue(true)).toBe(true);
      expect(normalizeNoProgressEvidenceValue(null)).toBe(null);
    });

    it("recursively normalizes nested objects", () => {
      const result = normalizeNoProgressEvidenceValue({
        data: { tabId: 1, content: "hello" },
      });
      expect(result).toEqual({ data: { content: "hello" } });
    });
  });

  describe("buildNoProgressEvidenceFingerprint", () => {
    it("returns a string fingerprint", () => {
      const fp = buildNoProgressEvidenceFingerprint({ action: "click", target: "btn" });
      expect(typeof fp).toBe("string");
      expect(fp.length).toBeGreaterThan(0);
    });

    it("produces same fingerprint for reordered keys", () => {
      const a = buildNoProgressEvidenceFingerprint({ b: 2, a: 1 });
      const b = buildNoProgressEvidenceFingerprint({ a: 1, b: 2 });
      expect(a).toBe(b);
    });

    it("ignores volatile keys in fingerprint", () => {
      const base = buildNoProgressEvidenceFingerprint({ action: "click" });
      const withVolatile = buildNoProgressEvidenceFingerprint({ action: "click", tabId: 99, sessionId: "s" });
      expect(base).toBe(withVolatile);
    });
  });

  describe("buildNoProgressScopeKey", () => {
    it("joins reason and scopeKey", () => {
      expect(buildNoProgressScopeKey("repeat_signature", "click|btn")).toBe("repeat_signature:click|btn");
    });

    it("uses default for empty scopeKey", () => {
      expect(buildNoProgressScopeKey("repeat_signature", "")).toBe("repeat_signature:(default)");
    });
  });

  describe("resolveNoProgressDecision", () => {
    it("increments hit counter and returns continue when under budget", () => {
      const hits = new Map<string, number>();
      const result = resolveNoProgressDecision(hits, "repeat_signature", "test");
      expect(result.hit).toBe(1);
      expect(result.decision).toBe("continue");
    });

    it("returns stop when budget exhausted", () => {
      const hits = new Map<string, number>();
      // Exhaust budget by calling repeatedly
      let result;
      for (let i = 0; i < 20; i++) {
        result = resolveNoProgressDecision(hits, "repeat_signature", "test");
      }
      expect(result!.decision).toBe("stop");
      expect(result!.remainingContinueBudget).toBe(0);
    });

    it("tracks separate buckets for different scope keys", () => {
      const hits = new Map<string, number>();
      resolveNoProgressDecision(hits, "repeat_signature", "a");
      resolveNoProgressDecision(hits, "repeat_signature", "b");
      expect(hits.size).toBe(2);
    });
  });
});
