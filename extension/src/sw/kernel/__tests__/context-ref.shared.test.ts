import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  extractPromptContextRefs,
  rewritePromptWithContextRefPlaceholders,
} from "../../../shared/context-ref";

describe("shared context-ref parser", () => {
  it("extracts host/browser refs and preserves invalid mem:// usage as explicit invalid ref", () => {
    const extracted = extractPromptContextRefs(
      "比较 @/mem/skills/demo/SKILL.md 和 @./README.md，再看 @mem://bad",
    );
    expect(extracted.refs.map((item) => item.displayPath)).toEqual([
      "/mem/skills/demo/SKILL.md",
      "./README.md",
      "mem://bad",
    ]);
    expect(extracted.refs[0]?.runtimeHint).toBe("browser");
    expect(extracted.refs[1]?.runtimeHint).toBe("host");
    expect(extracted.refs[2]?.runtimeHint).toBe("invalid");
  });

  it("rewrites prompt refs to stable placeholders", () => {
    const extracted = extractPromptContextRefs("请比较 @/tmp/a.ts 和 @/tmp/b.ts");
    const rewritten = rewritePromptWithContextRefPlaceholders(
      "请比较 @/tmp/a.ts 和 @/tmp/b.ts",
      extracted.refs,
    );
    expect(rewritten).toContain("[ref:ctx_");
    expect(rewritten).not.toContain("@/tmp/a.ts");
    expect(rewritten).not.toContain("@/tmp/b.ts");
  });
});
