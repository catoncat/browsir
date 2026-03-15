import { describe, expect, it } from "vitest";

import { extractContentFromStepExecuteResult } from "../skill-store";

describe("skill-store", () => {
  it("extracts nested read content from brain.step.execute payloads", () => {
    expect(
      extractContentFromStepExecuteResult({
        data: {
          data: {
            content: "# SKILL\nbody",
          },
        },
      }),
    ).toBe("# SKILL\nbody");
  });

  it("throws when no readable content field exists", () => {
    expect(() =>
      extractContentFromStepExecuteResult({
        data: {
          bytes: 12,
        },
      }),
    ).toThrow("文件读取工具未返回 content 文本");
  });
});