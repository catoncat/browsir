import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  buildFocusEscalationToolCall,
  buildToolFailurePayload,
  buildToolSuccessPayload,
} from "../loop-tool-display";

describe("loop-tool-display", () => {
  it("adds forceFocus to browser action tool calls", () => {
    const toolCall = buildFocusEscalationToolCall({
      id: "call_1",
      type: "function",
      function: {
        name: "click",
        arguments: JSON.stringify({
          uid: "btn-1",
          action: {
            type: "click",
          },
        }),
      },
    });

    expect(toolCall).not.toBeNull();
    expect(JSON.parse(String(toolCall?.function.arguments || ""))).toEqual({
      uid: "btn-1",
      forceFocus: true,
      action: {
        type: "click",
        forceFocus: true,
      },
    });
  });

  it("builds failure payload with retry hint and target summary", () => {
    const payload = buildToolFailurePayload(
      {
        id: "call_2",
        type: "function",
        function: {
          name: "execute_skill_script",
          arguments: JSON.stringify({
            skillName: "skill.fy",
            scriptPath: "scripts/main.ts",
          }),
        },
      },
      {
        error: "脚本执行失败",
        errorCode: "E_TIMEOUT",
      },
    );

    expect(payload.tool).toBe("execute_skill_script");
    expect(payload.target).toBe("执行技能脚本 · skill.fy:scripts/main.ts");
    expect(payload.retryable).toBe(true);
    expect(String(payload.retryHint || "")).toContain("retry");
  });

  it("builds success payload with summarized target", () => {
    const payload = buildToolSuccessPayload(
      {
        id: "call_3",
        type: "function",
        function: {
          name: "click",
          arguments: JSON.stringify({
            uid: "submit-button",
          }),
        },
      },
      {
        ok: true,
      },
      {
        modeUsed: "cdp",
      },
    );

    expect(payload.tool).toBe("click");
    expect(payload.target).toBe("点击 · submit-button");
    expect(payload.modeUsed).toBe("cdp");
    expect(payload.ok).toBe(true);
  });
});
