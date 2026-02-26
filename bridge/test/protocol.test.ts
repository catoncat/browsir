import { describe, expect, test } from "bun:test";
import { parseInvokeFrame } from "../src/protocol";

describe("parseInvokeFrame", () => {
  test("accepts invoke frame with session fields", () => {
    const frame = parseInvokeFrame(
      JSON.stringify({
        id: "u1",
        type: "invoke",
        tool: "read",
        args: { path: "README.md" },
        sessionId: "s1",
        parentSessionId: "p0",
        agentId: "a1",
      }),
    );

    expect(frame.id).toBe("u1");
    expect(frame.tool).toBe("read");
    expect(frame.canonicalTool).toBe("read");
    expect(frame.sessionId).toBe("s1");
    expect(frame.parentSessionId).toBe("p0");
    expect(frame.agentId).toBe("a1");
  });

  test("accepts canonical bash tool and keeps tool/canonicalTool consistent", () => {
    const frame = parseInvokeFrame(
      JSON.stringify({
        id: "u2",
        type: "invoke",
        tool: "bash",
        args: { cmdId: "echo", argv: ["hello"] },
      }),
    );

    expect(frame.tool).toBe("bash");
    expect(frame.canonicalTool).toBe("bash");
  });

  test("normalizes whitespace input to canonical tool name", () => {
    const frame = parseInvokeFrame(
      JSON.stringify({
        id: "u2b",
        type: "invoke",
        tool: "  read  ",
        args: { path: "README.md" },
      }),
    );

    expect(frame.tool).toBe("read");
    expect(frame.canonicalTool).toBe("read");
  });

  test("rejects unknown tool", () => {
    expect(() =>
      parseInvokeFrame(
        JSON.stringify({
          id: "u1",
          type: "invoke",
          tool: "xxx",
          args: {},
        }),
      ),
    ).toThrow();
  });

  test("rejects legacy alias tool", () => {
    expect(() =>
      parseInvokeFrame(
        JSON.stringify({
          id: "u1a",
          type: "invoke",
          tool: "read_file",
          args: {},
        }),
      ),
    ).toThrow();
  });

  test("rejects args array (args must be plain object)", () => {
    expect(() =>
      parseInvokeFrame(
        JSON.stringify({
          id: "u3",
          type: "invoke",
          tool: "read",
          args: ["README.md"],
        }),
      ),
    ).toThrow("args must be an object");
  });
});
