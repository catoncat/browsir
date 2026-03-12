import { describe, expect, it } from "vitest";
import {
  buildCursorHelpRequestBody,
  classifyCursorHelpHttpError,
  parseCursorHelpSseLine,
  resolveCursorHelpApiModel
} from "../../../shared/cursor-help-protocol";

describe("cursor-help-protocol", () => {
  it("maps UI label to Cursor Help api model", () => {
    expect(resolveCursorHelpApiModel("Sonnet 4.6")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveCursorHelpApiModel("auto", "Gemini 2.5 Pro")).toBe("google/gemini-2.5-pro");
    expect(resolveCursorHelpApiModel("openai/gpt-5")).toBe("openai/gpt-5");
  });

  it("builds request body without help page context", () => {
    const body = buildCursorHelpRequestBody({
      prompt: "hello",
      requestId: "req-1",
      messageId: "msg-1",
      requestedModel: "Sonnet 4.6"
    });

    expect(body).toMatchObject({
      model: "anthropic/claude-sonnet-4.6",
      id: "req-1",
      trigger: "submit-message"
    });
    expect(body.context).toEqual([]);
    expect(body.messages[0]).toMatchObject({
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }]
    });
  });

  it("parses Cursor Help SSE event lines", () => {
    expect(parseCursorHelpSseLine('data: {"type":"text-delta","id":"0","delta":"hello"}')).toEqual({
      kind: "delta",
      text: "hello"
    });
    expect(parseCursorHelpSseLine('data: {"type":"finish","finishReason":"stop"}')).toEqual({
      kind: "done"
    });
    expect(parseCursorHelpSseLine('data: [DONE]')).toEqual({
      kind: "done"
    });
  });

  it("classifies transport-level http errors in SW", () => {
    expect(classifyCursorHelpHttpError(401, "login required")).toContain("未登录");
    expect(classifyCursorHelpHttpError(500, "server exploded")).toContain("服务暂时异常");
  });
});
