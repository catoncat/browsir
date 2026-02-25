type JsonRecord = Record<string, unknown>;

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
  stopReason?: string;
}

export interface SessionContextMessageLike {
  role: string;
  content: string;
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

export function buildCompactionSummaryLlmMessage(previousSummary: string): JsonRecord | null {
  const summary = String(previousSummary || "").trim();
  if (!summary) return null;
  return {
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`
  };
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
  return typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
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

function normalizeIncomingMessage(raw: unknown, index: number): LlmMessage | null {
  const row = toRecord(raw);
  const roleRaw = String(row.role || "").trim().toLowerCase();
  const content = normalizeTextContent(row.content);
  if (roleRaw === "assistant") {
    const toolCalls = normalizeToolCalls(row.tool_calls);
    const stopReason = String(row.stopReason || row.stop_reason || "").trim().toLowerCase();
    if (!content && toolCalls.length === 0) return null;
    return {
      role: "assistant",
      content,
      tool_calls: toolCalls,
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
    content
  };
}

function insertSyntheticAssistantForOrphanToolResults(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  const declaredToolCalls = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
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
        content: "",
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: toolName,
              arguments: "{}"
            }
          }
        ]
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
      const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const normalizedToolCalls: LlmToolCall[] = [];
      for (let j = 0; j < rawToolCalls.length; j += 1) {
        const call = rawToolCalls[j];
        const rawId = String(call.id || `toolcall_${i + 1}_${j + 1}`);
        const normalizedId = normalizeToolCallId(rawId, `${call.function.name}_${i + 1}_${j + 1}`);
        if (normalizedId !== rawId) {
          map.set(rawId, normalizedId);
        }
        normalizedToolCalls.push({
          ...call,
          id: normalizedId
        });
      }
      out.push({
        ...message,
        tool_calls: normalizedToolCalls
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
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
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
    const out: JsonRecord = {
      role: "assistant",
      content: String(message.content || "")
    };
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
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

function readSummaryBody(rawContent: string): string {
  const content = String(rawContent || "");
  const prefix = "Previous summary:\n";
  if (!content.startsWith(prefix)) return content.trim();
  return content.slice(prefix.length).trim();
}

export function convertSessionContextMessagesToLlm(messages: SessionContextMessageLike[]): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i];
    const role = String(item.role || "").trim().toLowerCase();
    const content = String(item.content || "");
    if (!content.trim()) continue;

    if (role === "system" && String(item.entryId || "").startsWith("summary:")) {
      const summary = readSummaryBody(content);
      if (!summary) continue;
      const summaryMessage = buildCompactionSummaryLlmMessage(summary);
      if (summaryMessage) out.push(summaryMessage);
      continue;
    }

    if (role === "tool") {
      const toolCallId = String(item.toolCallId || "").trim();
      const toolName = String(item.toolName || "").trim();
      if (toolCallId) {
        out.push({
          role: "tool",
          tool_call_id: toolCallId,
          name: toolName || undefined,
          content
        });
      } else {
        out.push({
          role: "user",
          content: `Tool result (${toolName || "unknown"}):\n${content}`
        });
      }
      continue;
    }

    if (role === "user" || role === "assistant" || role === "system") {
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
