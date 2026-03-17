import { afterEach, describe, expect, it, vi } from "vitest";

import { collectDiagnostics } from "../diagnostics";

declare global {
  // eslint-disable-next-line no-var
  var chrome: {
    runtime: {
      sendMessage: ReturnType<typeof vi.fn>;
    };
  };
}

describe("diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("summarizes step and llm request ranges from the event stream", async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "brain.debug.config") {
        return {
          ok: true,
          data: {
            bridgeUrl: "ws://127.0.0.1:8787/ws",
            llmDefaultProfile: "cursor_help_web",
            llmProvider: "cursor_help_web",
            llmModel: "auto",
            hasLlmApiKey: false,
          },
        };
      }

      if (message.type === "brain.debug.dump") {
        return {
          ok: true,
          data: {
            sessionId: "session-1",
            runtime: {},
            conversationView: {
              messageCount: 1,
              messages: [],
            },
            stepStreamMeta: {
              truncated: false,
            },
            sandboxRuntime: {},
            stepStream: [
              { type: "step_planned", payload: { step: 2, mode: "tool_call", action: "search_elements" } },
              { type: "llm.request", payload: { step: 2, model: "gpt-5" } },
              { type: "step_finished", payload: { step: 2, mode: "tool_call", action: "search_elements", ok: true } },
              { type: "llm.request", payload: { step: 3, model: "gpt-5" } },
              { type: "step_planned", payload: { step: 4, mode: "tool_call", action: "click" } },
            ],
          },
        };
      }

      throw new Error(`unexpected message: ${message.type}`);
    });

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
      },
    });

    const result = await collectDiagnostics();
    const summary = result.payload.summary as Record<string, unknown>;

    expect(summary.toolStepCount).toBe(2);
    expect(summary.llmRequestCount).toBe(2);
    expect(summary.stepRange).toEqual([2, 4]);
    expect(summary.llmRequestRange).toEqual([2, 3]);
  });
});
