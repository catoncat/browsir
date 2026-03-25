type JsonRecord = Record<string, unknown>;

import type { ContentBlock } from "./types";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmTextBlock {
  type: "text";
  text: string;
}

export interface LlmToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: string;
}

export type LlmAssistantContentBlock = LlmTextBlock | LlmToolCallBlock;

export interface LlmAssistantMessage {
  role: "assistant";
  content: LlmAssistantContentBlock[];
  stopReason?: string;
}

export interface LlmContextMessage {
  role: "system" | "user" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export type LlmMessage = LlmAssistantMessage | LlmContextMessage;

export interface SessionContextMessageLike {
  role: string;
  content: string;
  llmContent?: string;
  contentBlocks?: ContentBlock[];
  entryId?: string;
  toolName?: string;
  toolCallId?: string;
}

const TOOL_CALL_ID_MAX = 64;
const TOOL_CALL_ID_VALID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

function toCompactionSummaryText(summary: string): string {
  return `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function normalizeTextContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      const row = toRecord(item);
      if (typeof row.text === "string") {
        parts.push(row.text);
        continue;
      }
      if (typeof row.input_text === "string") {
        parts.push(row.input_text);
        continue;
      }
      if (typeof row.content === "string") {
        parts.push(row.content);
      }
    }
    return parts.join("");
  }
  const row = toRecord(raw);
  if (typeof row.text === "string") return row.text;
  if (typeof row.thinking === "string") return row.thinking;
  return typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
}

function appendTextBlock(blocks: LlmAssistantContentBlock[], rawText: unknown): void {
  const text = normalizeTextContent(rawText);
  if (!text) return;
  blocks.push({
    type: "text",
    text
  });
}

function hashFNV1a(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function normalizeToolCallId(rawId: string, fallbackSeed = ""): string {
  const source = String(rawId || "").trim();
  if (TOOL_CALL_ID_VALID_RE.test(source)) return source;

  const base = source || fallbackSeed || `tool_${hashFNV1a(String(Date.now()))}`;
  const sanitized = base
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");

  if (TOOL_CALL_ID_VALID_RE.test(sanitized)) return sanitized;

  const hash = hashFNV1a(base);
  const compact = sanitized.slice(0, Math.max(0, TOOL_CALL_ID_MAX - hash.length - 2));
  const normalized = `${compact || "tool"}_${hash}`.slice(0, TOOL_CALL_ID_MAX);
  if (TOOL_CALL_ID_VALID_RE.test(normalized)) return normalized;
  return `tool_${hash}`.slice(0, TOOL_CALL_ID_MAX);
}

function normalizeToolCalls(rawToolCalls: unknown): LlmToolCall[] {
  if (!Array.isArray(rawToolCalls)) return [];
  const out: LlmToolCall[] = [];
  for (let i = 0; i < rawToolCalls.length; i += 1) {
    const row = toRecord(rawToolCalls[i]);
    const fn = toRecord(row.function);
    const name = String(fn.name || "").trim();
    if (!name) continue;
    const argsText = typeof fn.arguments === "string" ? fn.arguments : safeJsonStringify(fn.arguments || {});
    const rawId = String(row.id || `toolcall_${i + 1}`);
    out.push({
      id: rawId,
      type: "function",
      function: {
        name,
        arguments: argsText
      }
    });
  }
  return out;
}

function toAssistantToolCallBlock(call: LlmToolCall): LlmToolCallBlock {
  return {
    type: "toolCall",
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments
  };
}

function toToolCallFromBlock(rawBlock: unknown, fallbackSeed = ""): LlmToolCall | null {
  const row = toRecord(rawBlock);
  const blockType = String(row.type || "").trim();
  if (blockType !== "toolCall" && blockType !== "tool_call") return null;
  const fn = toRecord(row.function);
  const name = String(row.name || row.toolName || fn.name || "").trim();
  if (!name) return null;
  const rawArguments = row.arguments ?? fn.arguments ?? {};
  const argumentsText =
    typeof rawArguments === "string"
      ? rawArguments
      : safeJsonStringify(rawArguments);
  return {
    id: String(row.id || fallbackSeed || "toolcall_1"),
    type: "function",
    function: {
      name,
      arguments: argumentsText
    }
  };
}

function normalizeAssistantContent(
  rawContent: unknown,
  rawToolCalls: unknown
): LlmAssistantContentBlock[] {
  const blocks: LlmAssistantContentBlock[] = [];
  let hasToolCallBlock = false;

  if (Array.isArray(rawContent)) {
    for (let i = 0; i < rawContent.length; i += 1) {
      const item = rawContent[i];
      const toolCall = toToolCallFromBlock(item, `toolcall_${i + 1}`);
      if (toolCall) {
        hasToolCallBlock = true;
        blocks.push(toAssistantToolCallBlock(toolCall));
        continue;
      }
      appendTextBlock(blocks, item);
    }
  } else {
    const toolCall = toToolCallFromBlock(rawContent, "toolcall_1");
    if (toolCall) {
      hasToolCallBlock = true;
      blocks.push(toAssistantToolCallBlock(toolCall));
    } else {
      appendTextBlock(blocks, rawContent);
    }
  }

  if (!hasToolCallBlock) {
    for (const call of normalizeToolCalls(rawToolCalls)) {
      blocks.push(toAssistantToolCallBlock(call));
    }
  }

  return blocks;
}

export function buildAssistantContentBlocks(
  rawContent: unknown,
  rawToolCalls: unknown = []
): LlmAssistantContentBlock[] {
  return normalizeAssistantContent(rawContent, rawToolCalls);
}

function getAssistantTextContent(content: LlmAssistantContentBlock[]): string {
  return content
    .filter((block): block is LlmTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function getAssistantToolCalls(content: LlmAssistantContentBlock[]): LlmToolCall[] {
  const out: LlmToolCall[] = [];
  for (const block of content) {
    if (block.type !== "toolCall") continue;
    out.push({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: block.arguments
      }
    });
  }
  return out;
}

function normalizeIncomingMessage(raw: unknown, index: number): LlmMessage | null {
  const row = toRecord(raw);
  const roleRaw = String(row.role || "").trim().toLowerCase();
  const content = normalizeTextContent(row.content);
  if (roleRaw === "assistant") {
    const assistantContent = normalizeAssistantContent(row.content, row.tool_calls);
    const stopReason = String(row.stopReason || row.stop_reason || "").trim().toLowerCase();
    if (assistantContent.length === 0) return null;
    return {
      role: "assistant",
      content: assistantContent,
      stopReason: stopReason || undefined
    };
  }
  if (roleRaw === "tool") {
    const toolCallId = String(row.tool_call_id || row.toolCallId || "").trim();
    const name = String(row.name || row.toolName || "").trim();
    if (!toolCallId) {
      const legacyContent = content.trim();
      if (!legacyContent) return null;
      return {
        role: "user",
        content: `Tool result (${name || "unknown"}):\n${legacyContent}`
      };
    }
    return {
      role: "tool",
      content,
      tool_call_id: toolCallId,
      name: name || undefined
    };
  }
  if (roleRaw === "system" || roleRaw === "user") {
    if (!content.trim()) return null;
    return {
      role: roleRaw,
      content
    };
  }
  if (!content.trim()) return null;
  if (index === 0) {
    return {
      role: "system",
      content
    };
  }
  return {
    role: "assistant",
    content: buildAssistantContentBlocks(content)
  };
}

function insertSyntheticAssistantForOrphanToolResults(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  const declaredToolCalls = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      const toolCalls = getAssistantToolCalls(message.content);
      for (const call of toolCalls) {
        declaredToolCalls.add(call.id);
      }
      out.push(message);
      continue;
    }
    if (message.role !== "tool") {
      out.push(message);
      continue;
    }
    const toolCallId = String(message.tool_call_id || "").trim();
    const toolName = String(message.name || "").trim() || "tool_result";
    if (toolCallId && !declaredToolCalls.has(toolCallId)) {
      out.push({
        role: "assistant",
        content: buildAssistantContentBlocks("", [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: toolName,
              arguments: "{}"
            }
          }
        ])
      });
      declaredToolCalls.add(toolCallId);
    }
    out.push(message);
  }

  return out;
}

function patchToolCallIds(messages: LlmMessage[]): LlmMessage[] {
  const map = new Map<string, string>();
  const out: LlmMessage[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        continue;
      }
      const normalizedContent = message.content.map((block) => ({ ...block }));
      for (let j = 0; j < normalizedContent.length; j += 1) {
        const block = normalizedContent[j];
        if (block.type !== "toolCall") continue;
        const rawId = String(block.id || `toolcall_${i + 1}_${j + 1}`);
        const normalizedId = normalizeToolCallId(rawId, `${block.name}_${i + 1}_${j + 1}`);
        if (normalizedId !== rawId) {
          map.set(rawId, normalizedId);
        }
        normalizedContent[j] = {
          ...block,
          id: normalizedId
        };
      }
      out.push({
        ...message,
        content: normalizedContent
      });
      continue;
    }
    if (message.role === "tool") {
      const rawId = String(message.tool_call_id || "").trim();
      const mapped = map.get(rawId) || rawId;
      const normalizedId = normalizeToolCallId(mapped, `${message.name || "tool"}_${i + 1}`);
      out.push({
        ...message,
        tool_call_id: normalizedId
      });
      continue;
    }
    out.push(message);
  }

  return out;
}

function appendSyntheticMissingToolResults(messages: LlmMessage[]): LlmMessage[] {
  const result: LlmMessage[] = [];
  let pendingToolCalls: LlmToolCall[] = [];
  let existingToolResultIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        for (const call of pendingToolCalls) {
          if (existingToolResultIds.has(call.id)) continue;
          result.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: "No result provided"
          });
        }
        pendingToolCalls = [];
        existingToolResultIds = new Set<string>();
      }
      const toolCalls = getAssistantToolCalls(message.content);
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set<string>();
      }
      result.push(message);
      continue;
    }
    if (message.role === "tool") {
      existingToolResultIds.add(String(message.tool_call_id || ""));
      result.push(message);
      continue;
    }
    if (pendingToolCalls.length > 0) {
      for (const call of pendingToolCalls) {
        if (existingToolResultIds.has(call.id)) continue;
        result.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: "No result provided"
        });
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set<string>();
    }
    result.push(message);
  }

  return result;
}

function toSerializableMessage(message: LlmMessage): JsonRecord {
  if (message.role === "assistant") {
    const toolCalls = getAssistantToolCalls(message.content);
    const out: JsonRecord = {
      role: "assistant",
      content: getAssistantTextContent(message.content)
    };
    if (toolCalls.length > 0) {
      out.tool_calls = toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function.name,
          arguments: call.function.arguments
        }
      }));
    }
    return out;
  }
  if (message.role === "tool") {
    const out: JsonRecord = {
      role: "tool",
      tool_call_id: String(message.tool_call_id || ""),
      content: String(message.content || "")
    };
    if (message.name) out.name = String(message.name);
    return out;
  }
  return {
    role: message.role,
    content: String(message.content || "")
  };
}

export function transformMessagesForLlm(rawMessages: unknown[]): JsonRecord[] {
  const normalized: LlmMessage[] = [];
  for (let i = 0; i < rawMessages.length; i += 1) {
    const message = normalizeIncomingMessage(rawMessages[i], i);
    if (!message) continue;
    normalized.push(message);
  }

  const withSyntheticAssistant = insertSyntheticAssistantForOrphanToolResults(normalized);
  const withPatchedToolCallIds = patchToolCallIds(withSyntheticAssistant);
  const finalMessages = appendSyntheticMissingToolResults(withPatchedToolCallIds);
  return finalMessages.map((item) => toSerializableMessage(item));
}

const TOOL_CONTENT_MAX_CHARS_FOR_LLM = 12_000;

function clipToolContentForLlm(text: string): string {
  if (text.length <= TOOL_CONTENT_MAX_CHARS_FOR_LLM) return text;
  const marker = `\n...[clipped ${text.length - TOOL_CONTENT_MAX_CHARS_FOR_LLM} chars]...\n`;
  const headChars = Math.ceil((TOOL_CONTENT_MAX_CHARS_FOR_LLM - marker.length) * 0.7);
  const tailChars = TOOL_CONTENT_MAX_CHARS_FOR_LLM - marker.length - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

export function convertSessionContextMessagesToLlm(messages: SessionContextMessageLike[]): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i];
    const role = String(item.role || "").trim().toLowerCase();
    const content = String(item.llmContent ?? item.content ?? "");
    if (!content.trim()) continue;

    if (role === "compactionsummary") {
      out.push({
        role: "user",
        content: toCompactionSummaryText(content)
      });
      continue;
    }

    if (role === "tool") {
      const toolCallId = String(item.toolCallId || "").trim();
      const toolName = String(item.toolName || "").trim();
      const clippedContent = clipToolContentForLlm(content);
      if (toolCallId) {
        out.push({
          role: "tool",
          tool_call_id: toolCallId,
          name: toolName || undefined,
          content: clippedContent
        });
      } else {
        out.push({
          role: "user",
          content: `Tool result (${toolName || "unknown"}):\n${clippedContent}`
        });
      }
      continue;
    }

    if (role === "user" || role === "assistant" || role === "system") {
      // For assistant messages with contentBlocks, restore tool_calls for LLM context
      if (role === "assistant" && item.contentBlocks?.length) {
        const textParts = item.contentBlocks
          .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const toolCallBlocks = item.contentBlocks
          .filter((b): b is ContentBlock & { type: "toolCall" } => b.type === "toolCall");
        if (toolCallBlocks.length > 0) {
          const msg: JsonRecord = {
            role: "assistant",
            content: textParts || null,
            tool_calls: toolCallBlocks.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
          out.push(msg);
          continue;
        }
      }
      out.push({
        role,
        content
      });
      continue;
    }

    out.push({
      role: "assistant",
      content
    });
  }
  return out;
}
