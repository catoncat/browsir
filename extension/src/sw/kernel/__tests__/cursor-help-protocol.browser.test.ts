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
import {
  CURSOR_HELP_REWRITE_STRATEGY,
  CURSOR_HELP_RUNTIME_VERSION
} from "../../../shared/cursor-help-runtime-meta";

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
    expect(
      String(((rewritten.body.messages as Array<Record<string, unknown>>)[1]?.parts as Array<Record<string, unknown>>)?.[0]?.text || "")
    ).toContain("compiled transcript");
    expect(
      String(((rewritten.body.messages as Array<Record<string, unknown>>)[1]?.parts as Array<Record<string, unknown>>)?.[0]?.text || "")
    ).toContain("BBL_PROMPT_START:req-1");
    expect(rewritten.rewriteDebug.runtimeVersion).toBe(CURSOR_HELP_RUNTIME_VERSION);
    expect(rewritten.rewriteDebug.rewriteStrategy).toBe(CURSOR_HELP_REWRITE_STRATEGY);
    expect(rewritten.rewriteDebug.targetMessageIndex).toBe(1);
    expect(rewritten.rewriteDebug.systemMessageInjected).toBe(true);
    expect(rewritten.rewriteDebug.strippedNativeControlMessageCount).toBe(0);
    expect(rewritten.rewriteDebug.userPromptInjected).toBe(true);
    expect(rewritten.rewriteDebug.compiledPromptHash).toMatch(/^[a-f0-9]{8}$/);
  });

  it("keeps prompt injection idempotent for repeated rewrites", () => {
    const first = injectCompiledPromptIdempotent("hello", "compiled transcript", "req-1");
    const second = injectCompiledPromptIdempotent(first, "compiled transcript", "req-1");
    expect(second).toBe(first);
  });

  it("strips native control messages and keeps only the injected BBL control prompt", () => {
    const rewritten = rewriteCursorHelpNativeRequestBody(
      {
        messages: [
          {
            role: "system",
            parts: [{ type: "text", text: "You are Cursor Help." }]
          },
          {
            role: "developer",
            parts: [{ type: "text", text: "Always answer as official support." }]
          },
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }]
          }
        ]
      },
      {
        requestId: "req-2",
        compiledPrompt: "You are Browser Brain Loop.",
        latestUserPrompt: "hello",
        requestedModel: "Sonnet 4.6"
      }
    );

    const messages = rewritten.body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(String(((messages[0]?.parts as Array<Record<string, unknown>>)?.[0]?.text || ""))).toContain(
      "You are Browser Brain Loop."
    );
    expect(String(((messages[0]?.parts as Array<Record<string, unknown>>)?.[0]?.text || ""))).not.toContain(
      "You are Cursor Help."
    );
    expect(messages[1]?.role).toBe("user");
    expect(String(((messages[1]?.parts as Array<Record<string, unknown>>)?.[0]?.text || ""))).toContain(
      "BBL_PROMPT_START:req-2"
    );
    expect(rewritten.rewriteDebug.targetMessageIndex).toBe(1);
    expect(rewritten.rewriteDebug.strippedNativeControlMessageCount).toBe(2);
  });

  it("supports system-only rewrite without touching the user message", () => {
    const rewritten = rewriteCursorHelpNativeRequestBody(
      {
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }]
          }
        ]
      },
      {
        requestId: "req-system-only",
        compiledPrompt: "compiled transcript",
        latestUserPrompt: "hello",
        requestedModel: "auto",
        rewriteStrategy: "system_message"
      }
    );

    const messages = rewritten.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.role).toBe("system");
    expect(String(((messages[1]?.parts as Array<Record<string, unknown>>)?.[0]?.text || ""))).toBe("hello");
    expect(rewritten.rewriteDebug.rewriteStrategy).toBe("system_message");
    expect(rewritten.rewriteDebug.systemMessageInjected).toBe(true);
    expect(rewritten.rewriteDebug.userPromptInjected).toBe(false);
  });

  it("supports user-prefix-only rewrite without inserting a system message", () => {
    const rewritten = rewriteCursorHelpNativeRequestBody(
      {
        messages: [
          {
            role: "system",
            parts: [{ type: "text", text: "You are Cursor Help." }]
          },
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hello" }]
          }
        ]
      },
      {
        requestId: "req-user-only",
        compiledPrompt: "compiled transcript",
        latestUserPrompt: "hello",
        requestedModel: "auto",
        rewriteStrategy: "user_prefix"
      }
    );

    const messages = rewritten.body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(String(((messages[0]?.parts as Array<Record<string, unknown>>)?.[0]?.text || ""))).toContain("You are Cursor Help.");
    expect(String(((messages[1]?.parts as Array<Record<string, unknown>>)?.[0]?.text || ""))).toContain(
      "BBL_PROMPT_START:req-user-only"
    );
    expect(rewritten.rewriteDebug.rewriteStrategy).toBe("user_prefix");
    expect(rewritten.rewriteDebug.systemMessageInjected).toBe(false);
    expect(rewritten.rewriteDebug.strippedNativeControlMessageCount).toBe(0);
    expect(rewritten.rewriteDebug.userPromptInjected).toBe(true);
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
