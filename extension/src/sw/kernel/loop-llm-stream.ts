/**
 * loop-llm-stream.ts — LLM SSE / streaming response parsers
 */
import type { LlmResolvedRoute } from "./llm-provider";
import type { RuntimeErrorWithMeta, ToolCallItem } from "./loop-shared-types";
import { safeJsonParse, toRecord } from "./loop-shared-utils";
import {
  parseHostedChatTransportEvent,
  type HostedChatTransportEvent,
  type HostedChatTurnResult,
} from "../../shared/cursor-help-web-shared";
import { getProviderRuntimeKind } from "../../shared/llm-provider-config";

type JsonRecord = Record<string, unknown>;

export interface LlmSseStreamResult {
  message: JsonRecord;
  rawBody: string;
  packetCount: number;
}

export interface HostedChatStreamResult {
  result: HostedChatTurnResult;
  rawBody: string;
  eventCount: number;
}

export function resolveRouteRuntimeKind(
  route: LlmResolvedRoute,
): "model_llm" | "hosted_chat" {
  return route.runtimeKind || getProviderRuntimeKind(route.provider);
}

export function parseLlmMessageFromSse(rawBody: string): JsonRecord {
  const lines = String(rawBody || "").split(/\r?\n/);
  const toolByIndex = new Map<number, ToolCallItem>();
  let text = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = safeJsonParse(data);
    const packet = toRecord(parsed);
    const choices = Array.isArray(packet.choices) ? packet.choices : [];
    for (const choice of choices) {
      const row = toRecord(choice);
      const delta = toRecord(row.delta || row.message);
      const textChunk = extractDeltaText(delta);
      if (textChunk) text += textChunk;
      appendDeltaToolCalls(toolByIndex, delta);
    }
  }

  return {
    content: text,
    tool_calls: Array.from(toolByIndex.keys())
      .sort((a, b) => a - b)
      .map((idx) => toolByIndex.get(idx))
      .filter((item): item is ToolCallItem => Boolean(item)),
  };
}

export function extractDeltaText(delta: JsonRecord): string {
  const content = delta.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let out = "";
  for (const item of content) {
    const row = toRecord(item);
    const text = row.text;
    if (typeof text === "string") {
      out += text;
      continue;
    }
    const nested = row.content;
    if (typeof nested === "string") out += nested;
  }
  return out;
}

export function appendDeltaToolCalls(
  toolByIndex: Map<number, ToolCallItem>,
  delta: JsonRecord,
): void {
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const rawCall of toolCalls) {
    const call = toRecord(rawCall);
    const idx = Number.isInteger(call.index) ? Number(call.index) : 0;
    const prev = toolByIndex.get(idx) || {
      id: "",
      type: "function" as const,
      function: { name: "", arguments: "" },
    };
    if (typeof call.id === "string" && call.id) prev.id = call.id;
    const fn = toRecord(call.function);
    if (typeof fn.name === "string" && fn.name) {
      prev.function.name = prev.function.name
        ? `${prev.function.name}${fn.name}`
        : fn.name;
    }
    if (typeof fn.arguments === "string" && fn.arguments) {
      prev.function.arguments = `${prev.function.arguments || ""}${fn.arguments}`;
    }
    toolByIndex.set(idx, prev);
  }
}

export async function readLlmMessageFromSseStream(
  body: ReadableStream<Uint8Array>,
  onDeltaText?: (chunk: string) => void,
): Promise<LlmSseStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let packetCount = 0;
  const rawPackets: string[] = [];
  const toolByIndex = new Map<number, ToolCallItem>();

  const processLine = (rawLine: string) => {
    const line = String(rawLine || "").trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    rawPackets.push(`data: ${data}`);
    if (data === "[DONE]") return;

    const parsed = safeJsonParse(data);
    const packet = toRecord(parsed);
    packetCount += 1;
    const choices = Array.isArray(packet.choices) ? packet.choices : [];
    for (const choice of choices) {
      const row = toRecord(choice);
      const delta = toRecord(row.delta || row.message);
      const textChunk = extractDeltaText(delta);
      if (textChunk) {
        text += textChunk;
        if (onDeltaText) onDeltaText(textChunk);
      }
      appendDeltaToolCalls(toolByIndex, delta);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak >= 0) {
        const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
        buffer = buffer.slice(lineBreak + 1);
        processLine(line);
        lineBreak = buffer.indexOf("\n");
      }
    }

    const tail = buffer + decoder.decode();
    if (tail.trim()) processLine(tail.replace(/\r$/, ""));
  } finally {
    reader.releaseLock();
  }

  return {
    message: {
      content: text,
      tool_calls: Array.from(toolByIndex.keys())
        .sort((a, b) => a - b)
        .map((idx) => toolByIndex.get(idx))
        .filter((item): item is ToolCallItem => Boolean(item)),
    },
    rawBody: rawPackets.join("\n"),
    packetCount,
  };
}

export async function readHostedChatTurnFromTransportStream(
  body: ReadableStream<Uint8Array>,
  onEvent?: (event: HostedChatTransportEvent) => void,
): Promise<HostedChatStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;
  let resolved: HostedChatTurnResult | null = null;
  let transportError: { message: string; meta: JsonRecord } | null = null;
  const rawLines: string[] = [];

  const processLine = (rawLine: string) => {
    const line = String(rawLine || "").trim();
    if (!line) return;
    const event = parseHostedChatTransportEvent(line);
    if (!event) return;
    eventCount += 1;
    rawLines.push(line);
    if (onEvent) onEvent(event);
    if (event.type === "hosted_chat.turn_resolved") {
      resolved = event.result;
      return;
    }
    if (event.type === "hosted_chat.transport_error") {
      transportError = {
        message: event.error,
        meta: toRecord(event.meta),
      };
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineBreak = buffer.indexOf("\n");
      while (lineBreak >= 0) {
        const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
        buffer = buffer.slice(lineBreak + 1);
        processLine(line);
        lineBreak = buffer.indexOf("\n");
      }
    }

    const tail = buffer + decoder.decode();
    if (tail.trim()) processLine(tail.replace(/\r$/, ""));
  } finally {
    reader.releaseLock();
  }

  const latestTransportError = transportError as {
    message: string;
    meta: JsonRecord;
  } | null;
  if (latestTransportError) {
    const error = new Error(
      latestTransportError.message || "网页宿主聊天执行失败",
    ) as RuntimeErrorWithMeta;
    error.code = "E_HOSTED_CHAT_TRANSPORT";
    error.details = latestTransportError.meta;
    error.retryable = false;
    throw error;
  }

  if (!resolved) {
    const error = new Error(
      "网页宿主聊天回合未返回最终结果",
    ) as RuntimeErrorWithMeta;
    error.code = "E_HOSTED_CHAT_NO_TURN_RESULT";
    error.retryable = false;
    throw error;
  }

  return {
    result: resolved,
    rawBody: rawLines.join("\n"),
    eventCount,
  };
}

export function hostedChatTurnToMessage(
  result: HostedChatTurnResult,
): JsonRecord {
  return {
    content: result.finishReason === "tool_calls" ? "" : result.assistantText,
    tool_calls: result.toolCalls,
    finish_reason: result.finishReason,
    meta: result.meta,
  };
}

export function buildHostedChatEventPayload(
  step: number,
  attempt: number,
  event: HostedChatTransportEvent,
): JsonRecord {
  if (event.type === "hosted_chat.stream_text_delta") {
    return {
      step,
      attempt,
      text: event.deltaText || "",
      textLength: String(event.deltaText || "").length,
      ...toRecord(event.meta),
    };
  }
  if (event.type === "hosted_chat.tool_call_detected") {
    return {
      step,
      attempt,
      toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls.length : 0,
      assistantText: String(event.assistantText || ""),
      assistantTextLength: String(event.assistantText || "").length,
      ...toRecord(event.meta),
    };
  }
  if (event.type === "hosted_chat.turn_resolved") {
    return {
      step,
      attempt,
      finishReason: event.result.finishReason,
      toolCalls: Array.isArray(event.result.toolCalls)
        ? event.result.toolCalls.length
        : 0,
      assistantTextLength: String(event.result.assistantText || "").length,
      ...toRecord(event.result.meta),
    };
  }
  if (event.type === "hosted_chat.transport_error") {
    return {
      step,
      attempt,
      error: event.error,
      ...toRecord(event.meta),
    };
  }
  return {
    step,
    attempt,
    stage: event.stage,
    detail: event.detail || "",
    ...toRecord(event.meta),
  };
}

export function parseLlmMessageFromBody(
  rawBody: string,
  contentType: string,
): JsonRecord {
  const body = String(rawBody || "");
  const lowerType = String(contentType || "").toLowerCase();
  if (
    lowerType.includes("text/event-stream") ||
    body.trim().startsWith("data:")
  ) {
    return parseLlmMessageFromSse(body);
  }
  const parsed = safeJsonParse(body);
  const payload = toRecord(parsed);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return toRecord(toRecord(choices[0]).message);
}
