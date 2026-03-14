import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  parseLlmMessageFromBody,
  parseLlmMessageFromSse,
  readHostedChatTurnFromTransportStream,
  readLlmMessageFromSseStream,
} from "../loop-llm-stream";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("loop-llm-stream", () => {
  it("parses SSE body into assistant text and merged tool calls", () => {
    const rawBody = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_","arguments":"{\\"tab\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"tabs","arguments":"1}"}}]}}]}',
      "data: [DONE]",
    ].join("\n");

    expect(parseLlmMessageFromSse(rawBody)).toEqual({
      content: "hello",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_tabs",
            arguments: '{"tab":1}',
          },
        },
      ],
    });

    expect(parseLlmMessageFromBody(rawBody, "text/event-stream")).toEqual({
      content: "hello",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_tabs",
            arguments: '{"tab":1}',
          },
        },
      ],
    });
  });

  it("reads SSE stream incrementally and preserves delta order", async () => {
    const chunks: string[] = [];
    const rawBody = [
      'data: {"choices":[{"delta":{"content":"hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "data: [DONE]",
    ].join("\n");

    const result = await readLlmMessageFromSseStream(
      streamFromText(rawBody),
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toEqual(["hel", "lo"]);
    expect(result.message).toEqual({
      content: "hello",
      tool_calls: [],
    });
    expect(result.packetCount).toBe(2);
  });

  it("reads hosted chat transport stream until turn_resolved", async () => {
    const rawBody = [
      JSON.stringify({
        type: "hosted_chat.debug",
        requestId: "req_1",
        stage: "request_started",
      }),
      JSON.stringify({
        type: "hosted_chat.stream_text_delta",
        requestId: "req_1",
        deltaText: "hello",
      }),
      JSON.stringify({
        type: "hosted_chat.turn_resolved",
        requestId: "req_1",
        result: {
          assistantText: "hello",
          toolCalls: [],
          finishReason: "stop",
          meta: {
            assistantTextLength: 5,
          },
        },
      }),
    ].join("\n");

    const events: string[] = [];
    const result = await readHostedChatTurnFromTransportStream(
      streamFromText(rawBody),
      (event) => events.push(event.type),
    );

    expect(events).toEqual([
      "hosted_chat.debug",
      "hosted_chat.stream_text_delta",
      "hosted_chat.turn_resolved",
    ]);
    expect(result.result.assistantText).toBe("hello");
    expect(result.result.finishReason).toBe("stop");
    expect(result.eventCount).toBe(3);
  });
});
