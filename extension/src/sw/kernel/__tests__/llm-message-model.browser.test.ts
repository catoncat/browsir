import { describe, expect, it } from "vitest";
import { convertSessionContextMessagesToLlm, transformMessagesForLlm } from "../llm-message-model.browser";

function asMessages(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

describe("llm-message-model.browser", () => {
  it("为孤立 tool 结果补前置 assistant tool_call", () => {
    const out = asMessages(
      transformMessagesForLlm([
        { role: "user", content: "读取文件" },
        {
          role: "tool",
          tool_call_id: "call_read_1",
          name: "read_file",
          content: "{\"ok\":true}"
        }
      ])
    );

    expect(out).toHaveLength(3);
    expect(String(out[0]?.role || "")).toBe("user");
    expect(String(out[1]?.role || "")).toBe("assistant");
    expect(String(out[2]?.role || "")).toBe("tool");
    const toolCalls = asMessages(out[1]?.tool_calls);
    expect(String(toolCalls[0]?.id || "")).toBe("call_read_1");
    expect(String((toolCalls[0]?.function as Record<string, unknown> | undefined)?.name || "")).toBe("read_file");
    expect(String(out[2]?.tool_call_id || "")).toBe("call_read_1");
  });

  it("assistant 未配对 tool_call 会补 synthetic tool 结果并保持 id 一致", () => {
    const out = asMessages(
      transformMessagesForLlm([
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call|bad/id",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"/tmp/a.txt\"}"
              }
            }
          ]
        },
        { role: "user", content: "继续" }
      ])
    );

    expect(out).toHaveLength(3);
    expect(String(out[0]?.role || "")).toBe("assistant");
    expect(String(out[1]?.role || "")).toBe("tool");
    expect(String(out[2]?.role || "")).toBe("user");

    const assistantCalls = asMessages(out[0]?.tool_calls);
    const normalizedId = String(assistantCalls[0]?.id || "");
    expect(normalizedId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(String(out[1]?.tool_call_id || "")).toBe(normalizedId);
    expect(String(out[1]?.content || "")).toBe("No result provided");
  });

  it("session context 转换对齐 compaction summary 与 tool role", () => {
    const out = asMessages(
      convertSessionContextMessagesToLlm([
        {
          role: "system",
          entryId: "summary:session-1",
          content: "Previous summary:\nline-a\nline-b"
        },
        {
          role: "tool",
          content: "{\"ok\":true}",
          toolName: "read_file",
          toolCallId: "call_read_1"
        },
        {
          role: "tool",
          content: "legacy content",
          toolName: "write_file"
        }
      ])
    );

    expect(out).toHaveLength(3);
    expect(String(out[0]?.role || "")).toBe("user");
    expect(String(out[0]?.content || "")).toContain("<summary>");
    expect(String(out[0]?.content || "")).toContain("line-a");

    expect(String(out[1]?.role || "")).toBe("tool");
    expect(String(out[1]?.tool_call_id || "")).toBe("call_read_1");
    expect(String(out[1]?.name || "")).toBe("read_file");

    expect(String(out[2]?.role || "")).toBe("user");
    expect(String(out[2]?.content || "")).toContain("Tool result (write_file)");
  });
});
