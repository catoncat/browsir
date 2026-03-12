import { describe, expect, it } from "vitest";
import {
  classifyCursorHelpHttpError,
  deriveCursorHelpSessionKey,
  injectCompiledPromptIdempotent,
  isCursorHelpTargetRequestUrl,
  parseCursorHelpSseLine,
  resolveCursorHelpApiModel,
  rewriteCursorHelpNativeRequestBody
} from "../../../shared/cursor-help-protocol";

describe("cursor-help-protocol", () => {
  it("maps UI label to Cursor Help api model", () => {
    expect(resolveCursorHelpApiModel("Sonnet 4.6")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveCursorHelpApiModel("auto", "Gemini 2.5 Pro")).toBe("google/gemini-2.5-pro");
    expect(resolveCursorHelpApiModel("openai/gpt-5")).toBe("openai/gpt-5");
  });

  it("rewrites native request body while preserving envelope", () => {
    const rewritten = rewriteCursorHelpNativeRequestBody(
      {
        id: "req-1",
        conversationId: "conv-1",
        trigger: "submit-message",
        context: [{ type: "file", filePath: "/tmp/demo.ts" }],
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }]
          }
        ]
      },
      {
        requestId: "req-1",
        compiledPrompt: "compiled transcript",
        latestUserPrompt: "who are you?",
        requestedModel: "Sonnet 4.6"
      }
    );

    expect(rewritten.rewritten).toBe(true);
    expect(rewritten.sessionKey).toBe("cursor-help:req-1");
    expect(rewritten.body).toMatchObject({
      id: "req-1",
      conversationId: "conv-1",
      trigger: "submit-message",
      context: [{ type: "file", filePath: "/tmp/demo.ts" }]
    });
    expect((rewritten.body.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
      role: "system"
    });
    expect(((rewritten.body.messages as Array<Record<string, unknown>>)[0]?.parts as Array<Record<string, unknown>>)[0]?.text).toContain(
      "compiled transcript"
    );
    expect((rewritten.body.messages as Array<Record<string, unknown>>)[1]?.parts).toEqual([
      {
        type: "text",
        text: "who are you?"
      }
    ]);
  });

  it("keeps prompt injection idempotent for repeated rewrites", () => {
    const first = injectCompiledPromptIdempotent("hello", "compiled transcript", "req-1");
    const second = injectCompiledPromptIdempotent(first, "compiled transcript", "req-1");
    expect(second).toBe(first);
  });

  it("recognizes allowed request paths and derives fallback session key", () => {
    expect(isCursorHelpTargetRequestUrl("https://cursor.com/api/chat")).toBe(true);
    expect(isCursorHelpTargetRequestUrl("https://cursor.com/v1/chat/completions")).toBe(true);
    expect(isCursorHelpTargetRequestUrl("https://cursor.com/help/getting-started/install")).toBe(false);
    expect(
      deriveCursorHelpSessionKey({
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello world" }]
          }
        ]
      }, "https://cursor.com/api/chat")
    ).toContain("cursor-help:derived:");
  });

  it("parses Cursor Help SSE event lines", () => {
    expect(parseCursorHelpSseLine('data: {"type":"text-delta","id":"0","delta":"hello"}')).toEqual({
      kind: "delta",
      text: "hello"
    });
    expect(parseCursorHelpSseLine('data: {"type":"finish","finishReason":"stop"}')).toEqual({
      kind: "done"
    });
    expect(parseCursorHelpSseLine("data: [DONE]")).toEqual({
      kind: "done"
    });
  });

  it("classifies transport-level http errors in SW", () => {
    expect(classifyCursorHelpHttpError(401, "login required")).toContain("未登录");
    expect(classifyCursorHelpHttpError(500, "server exploded")).toContain("服务暂时异常");
  });
});
