import { describe, expect, test } from "bun:test";
import { applyUnifiedPatch } from "../src/tools/patch";

describe("applyUnifiedPatch", () => {
  test("applies basic patch", () => {
    const original = "a\nb\nc\n";
    const patch = `@@ -1,3 +1,3 @@\n a\n-b\n+x\n c`;

    const out = applyUnifiedPatch(original, patch);
    expect(out.hunksApplied).toBe(1);
    expect(out.content).toBe("a\nx\nc\n");
  });

  test("throws on context mismatch", () => {
    const original = "a\nb\nc\n";
    const patch = `@@ -1,3 +1,3 @@\n a\n-z\n+x\n c`;

    expect(() => applyUnifiedPatch(original, patch)).toThrow();
  });
});
