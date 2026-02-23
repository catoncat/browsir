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
    expect(frame.sessionId).toBe("s1");
    expect(frame.parentSessionId).toBe("p0");
    expect(frame.agentId).toBe("a1");
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
});
