type JsonRecord = Record<string, unknown>;

export interface CursorHelpChatContextItem {
  type: string;
  content?: string;
  filePath?: string;
}

export interface CursorHelpChatMessagePart {
  type: "text";
  text: string;
}

export interface CursorHelpChatMessage {
  parts: CursorHelpChatMessagePart[];
  id: string;
  role: "user";
}

export interface CursorHelpRequestBody {
  context: CursorHelpChatContextItem[];
  model: string;
  id: string;
  messages: CursorHelpChatMessage[];
  trigger: "submit-message";
}

export interface CursorHelpParsedSseEvent {
  kind: "delta" | "done" | "error" | "ignore";
  text?: string;
  error?: string;
}

const MODEL_ALIASES: Array<{ match: RegExp; apiModel: string }> = [
  { match: /anthropic\/claude-sonnet-4\.6|claude-sonnet-4\.6|sonnet 4\.6/i, apiModel: "anthropic/claude-sonnet-4.6" },
  { match: /anthropic\/claude-sonnet-4|claude-sonnet-4|sonnet 4/i, apiModel: "anthropic/claude-sonnet-4" },
  { match: /anthropic\/claude-opus-4\.1|claude-opus-4\.1|opus 4\.1/i, apiModel: "anthropic/claude-opus-4.1" },
  { match: /anthropic\/claude-opus-4|claude-opus-4|opus 4/i, apiModel: "anthropic/claude-opus-4" },
  { match: /google\/gemini-2\.5-pro|gemini-2\.5-pro|gemini 2\.5 pro/i, apiModel: "google/gemini-2.5-pro" },
  { match: /google\/gemini-2\.5-flash|gemini-2\.5-flash|gemini 2\.5 flash/i, apiModel: "google/gemini-2.5-flash" },
  { match: /openai\/gpt-5|gpt-5/i, apiModel: "openai/gpt-5" },
  { match: /openai\/gpt-4\.1|gpt-4\.1/i, apiModel: "openai/gpt-4.1" },
  { match: /openai\/o3|o3/i, apiModel: "openai/o3" },
  { match: /openai\/o1|o1/i, apiModel: "openai/o1" }
];

function normalizeModelText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function resolveCursorHelpApiModel(requestedModel: string, detectedModel = ""): string {
  const candidates = [requestedModel, detectedModel];
  for (const candidate of candidates) {
    const normalized = normalizeModelText(candidate);
    if (!normalized || normalized.toLowerCase() === "auto") continue;
    for (const alias of MODEL_ALIASES) {
      if (alias.match.test(normalized)) return alias.apiModel;
    }
    if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(normalized)) {
      return normalized;
    }
  }
  return "anthropic/claude-sonnet-4.6";
}

export function buildCursorHelpRequestBody(input: {
  prompt: string;
  requestId: string;
  messageId: string;
  requestedModel: string;
  detectedModel?: string;
}): CursorHelpRequestBody {
  return {
    context: [],
    model: resolveCursorHelpApiModel(input.requestedModel, input.detectedModel || ""),
    id: input.requestId,
    messages: [
      {
        parts: [
          {
            type: "text",
            text: String(input.prompt || "")
          }
        ],
        id: input.messageId,
        role: "user"
      }
    ],
    trigger: "submit-message"
  };
}

export function parseCursorHelpSseLine(line: string): CursorHelpParsedSseEvent {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("data:")) return { kind: "ignore" };
  const payload = trimmed.slice(5).trim();
  if (!payload) return { kind: "ignore" };
  if (payload === "[DONE]") return { kind: "done" };

  let parsed: JsonRecord = {};
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "ignore" };
  }

  if (parsed.type === "text-delta" && typeof parsed.delta === "string") {
    return {
      kind: "delta",
      text: parsed.delta
    };
  }
  if (parsed.type === "finish") {
    return { kind: "done" };
  }
  if (parsed.type === "error") {
    return {
      kind: "error",
      error: String(parsed.errorText || parsed.message || "Cursor Help SSE error")
    };
  }
  return { kind: "ignore" };
}
