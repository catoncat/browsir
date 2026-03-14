import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  buildLlmFailureSignature,
  extractRetryDelayHintMs,
  parseRetryAfterHeaderValue,
  readSessionLlmRoutePrefs,
} from "../loop-llm-route";

describe("loop-llm-route", () => {
  it("reads session route preferences from metadata", () => {
    expect(
      readSessionLlmRoutePrefs({
        header: {
          metadata: {
            llmProfile: "cursor-help",
            llmRole: "planner",
          },
        },
      }),
    ).toEqual({
      profile: "cursor-help",
      role: "planner",
    });

    expect(readSessionLlmRoutePrefs(null)).toEqual({
      profile: undefined,
      role: undefined,
    });
  });

  it("normalizes LLM failure signature", () => {
    expect(
      buildLlmFailureSignature({
        code: "e_timeout",
        status: 504,
        message: " Request Timed Out ",
      }),
    ).toBe("E_TIMEOUT|504|request timed out");
  });

  it("extracts retry delay hints from headers and body", () => {
    expect(parseRetryAfterHeaderValue("2")).toBe(2000);

    const headerResponse = new Response("{}", {
      headers: {
        "retry-after": "3",
      },
    });
    expect(extractRetryDelayHintMs("", headerResponse)).toBe(3000);

    const bodyResponse = new Response('{"error":"rate_limit"}');
    expect(
      extractRetryDelayHintMs('{"retryDelay":"1.5s"}', bodyResponse),
    ).toBe(1500);
  });
});
