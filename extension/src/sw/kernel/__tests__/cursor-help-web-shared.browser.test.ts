import { describe, expect, it } from "vitest";
import {
  buildHostedChatTurnResult,
  buildCursorHelpCompiledPrompt,
  extractLastUserMessage,
  extractLastUserPreview,
  normalizeHostedAssistantIdentity,
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
    expect(prompt).toContain("You are a browser-extension agent");
    expect(prompt).toContain("Do not volunteer identity in normal task replies");
    expect(prompt).toContain("If no host persona is provided");
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

  it("repairs common unescaped quotes inside JSON string values", () => {
    const parsed = parseToolProtocolFromText(`
[TM_TOOL_CALL_START:fill1]
await mcp.call("fill_element_by_uid", {"tabId":543592833,"uid":"bn-2383","value":"你理解"痛苦"、"美"、"死亡"这些概念时有什么不同？","forceFocus":true})
[TM_TOOL_CALL_END:fill1]
`);

    expect(parsed).not.toBeNull();
    expect(parsed?.toolCalls).toHaveLength(1);
    expect(parsed?.toolCalls[0]?.function.name).toBe("fill_element_by_uid");
    expect(parsed?.toolCalls[0]?.function.arguments).toBe(
      JSON.stringify({
        tabId: 543592833,
        uid: "bn-2383",
        value: '你理解"痛苦"、"美"、"死亡"这些概念时有什么不同？',
        forceFocus: true,
      }),
    );
  });

  it("builds a hosted turn result with leading assistant text and tool calls", () => {
    const result = buildHostedChatTurnResult(`
我已经看到回复了，现在继续找输入框。
[TM_TOOL_CALL_START:call_scroll]
await mcp.call("scroll_page", {"deltaY":500})
[TM_TOOL_CALL_END:call_scroll]
`);

    expect(result.finishReason).toBe("tool_calls");
    expect(result.assistantText).toContain("我已经看到回复了");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.name).toBe("scroll_page");
  });

  it("accepts markdown fences and smart quotes in hosted tool protocol", () => {
    const result = buildHostedChatTurnResult(`
[TM_TOOL_CALL_START:call_1]
\`\`\`js
await mcp.call("search_docs", {“q”：“runtime router”})
\`\`\`
[TM_TOOL_CALL_END:call_1]
`);

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.arguments).toBe(
      JSON.stringify({ q: "runtime router" }),
    );
  });

  it("does not convert literal pseudo tool text into executable tool calls", () => {
    const result = buildHostedChatTurnResult(
      '用户提到了字面量 [TM_TOOL_CALL_START:test]，但这里没有真正的 await 调用。',
    );

    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.assistantText).toContain("[TM_TOOL_CALL_START:test]");
  });

  it("normalizes hosted identity answers when the user asks who it is", () => {
    const normalized = normalizeHostedAssistantIdentity(
      "你是谁？",
      "我是 Cursor，负责帮助用户了解 Cursor 文档。",
    );

    expect(normalized).toContain("浏览器");
    expect(normalized).not.toContain("我是 Cursor");
    expect(normalized).not.toContain("了解 Cursor 文档");
  });

  it("strips only the leading drift sentence for non-identity replies", () => {
    const normalized = normalizeHostedAssistantIdentity(
      "帮我继续填这个表单",
      "我是 Cursor 支持助手。接下来我会继续填写表单。",
    );

    expect(normalized).toBe("接下来我会继续填写表单。");
    expect(normalized).not.toContain("我是 Cursor 支持助手");
    expect(normalized).not.toContain("Browser Brain Loop");
  });

  it("preserves markdown newlines when no identity rewrite is needed", () => {
    const markdown = [
      "根据维基百科3月25日页面，以下是**历史上的今天**大事记：",
      "",
      "---",
      "",
      "## 历史上的今天（3月25日）",
      "",
      "### 大事记",
      "",
      "| 年份 | 事件 |",
      "|---|---|",
      "| **410年** | 南燕灭亡 |",
    ].join("\n");

    const normalized = normalizeHostedAssistantIdentity(
      "帮我总结3月25日历史大事",
      markdown,
    );

    expect(normalized).toBe(markdown);
    expect(normalized).toContain("\n\n## 历史上的今天（3月25日）\n\n");
    expect(normalized).toContain("\n| 年份 | 事件 |\n|---|---|\n");
  });
});
