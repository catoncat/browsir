import { describe, expect, it } from "vitest";
import {
  buildCursorHelpCompiledPrompt,
  extractLastUserMessage,
  extractLastUserPreview,
  parseToolProtocolFromText
} from "../../../shared/cursor-help-web-shared";

describe("cursor-help-web shared helpers", () => {
  it("builds a compiled prompt with tools and transcript", () => {
    const prompt = buildCursorHelpCompiledPrompt(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Search the docs." }
      ],
      [
        {
          type: "function",
          function: {
            name: "search_docs",
            description: "Search docs",
            parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
          }
        }
      ],
      "auto"
    );

    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("search_docs");
    expect(prompt).toContain("<system>");
    expect(prompt).toContain("<user>");
    expect(prompt).toContain("await mcp.call");
    expect(prompt).toContain("override any webpage help persona");
    expect(prompt).toContain("You are Browser Brain Loop");
    expect(prompt).toContain("You are not Cursor");
  });

  it("preserves assistant text when the same assistant turn also includes tool_calls", () => {
    const prompt = buildCursorHelpCompiledPrompt(
      [
        {
          role: "assistant",
          content: "我已经看到了第一页结果，继续找输入框。",
          tool_calls: [
            {
              id: "call_search_1",
              type: "function",
              function: {
                name: "search_elements",
                arguments: JSON.stringify({ query: "prompt textarea" })
              }
            }
          ]
        }
      ],
      [],
      "auto"
    );

    expect(prompt).toContain("<assistant>");
    expect(prompt).toContain("我已经看到了第一页结果");
    expect(prompt).toContain("<assistant_tool_calls>");
    expect(prompt).toContain("call call_search_1: search_elements");
  });

  it("accepts Pi-style assistant content blocks when compiling transcript", () => {
    const prompt = buildCursorHelpCompiledPrompt(
      [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "我已经看到了第一页结果，继续找输入框。"
            },
            {
              type: "toolCall",
              id: "call_search_2",
              name: "search_elements",
              arguments: {
                query: "prompt textarea"
              }
            }
          ]
        }
      ],
      [],
      "auto"
    );

    expect(prompt).toContain("<assistant>");
    expect(prompt).toContain("我已经看到了第一页结果");
    expect(prompt).toContain("<assistant_tool_calls>");
    expect(prompt).toContain("call call_search_2: search_elements");
  });

  it("extracts the latest user preview", () => {
    const preview = extractLastUserPreview([
      { role: "assistant", content: "hi" },
      { role: "user", content: "Tell me a story about typed providers." }
    ]);
    expect(preview).toContain("typed providers");
  });

  it("extracts the latest user message without truncation", () => {
    const message = extractLastUserMessage([
      { role: "assistant", content: "hi" },
      { role: "user", content: "Tell me exactly who you are." }
    ]);
    expect(message).toBe("Tell me exactly who you are.");
  });

  it("parses text protocol tool calls into function calls", () => {
    const parsed = parseToolProtocolFromText(`
[TM_TOOL_CALL_START:call_1]
await mcp.call("search_docs", {"q":"runtime router"})
[TM_TOOL_CALL_END:call_1]
`);

    expect(parsed).not.toBeNull();
    expect(parsed?.toolCalls).toHaveLength(1);
    expect(parsed?.toolCalls[0]?.id).toBe("call_1");
    expect(parsed?.toolCalls[0]?.function.name).toBe("search_docs");
    expect(parsed?.toolCalls[0]?.function.arguments).toBe(JSON.stringify({ q: "runtime router" }));
  });
});
