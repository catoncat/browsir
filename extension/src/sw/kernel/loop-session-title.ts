import type { BrainOrchestrator } from "./orchestrator.browser";
import type { LlmResolvedRoute } from "./llm-provider";
import { LlmProviderRegistry } from "./llm-provider-registry";
import type { RuntimeInfraHandler } from "./runtime-infra.browser";
import { writeSessionMeta } from "./session-store.browser";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  MAX_LLM_TIMEOUT_MS,
  MIN_LLM_TIMEOUT_MS,
  SESSION_TITLE_MAX,
  SESSION_TITLE_SOURCE_AI,
  SESSION_TITLE_SOURCE_MANUAL,
} from "./loop-shared-types";
import {
  callInfra,
  clipText,
  extractLlmConfig,
  normalizeIntInRange,
  toRecord,
} from "./loop-shared-utils";
import { type SessionMeta } from "./types";
import { parseLlmMessageFromBody } from "./loop-llm-stream";
import { resolveAuxiliaryLlmRoute } from "./loop-llm-route";

export function normalizeSessionTitle(value: unknown, fallback = ""): string {
  const compact = String(value || "")
    .replace(/[`*_>#\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= SESSION_TITLE_MAX) return compact;
  return `${compact.slice(0, SESSION_TITLE_MAX)}…`;
}

export function readSessionTitleSource(meta: SessionMeta | null): string {
  const metadata = toRecord(meta?.header?.metadata);
  const source = String(metadata.titleSource || "")
    .trim()
    .toLowerCase();
  if (
    source === SESSION_TITLE_SOURCE_MANUAL ||
    source === SESSION_TITLE_SOURCE_AI
  ) {
    return source;
  }
  return "";
}

export function withSessionTitleMeta(
  meta: SessionMeta,
  title: string,
  source: string,
): SessionMeta {
  const metadata = {
    ...toRecord(meta.header.metadata),
  };
  if (source) {
    metadata.titleSource = source;
  } else {
    delete metadata.titleSource;
  }
  return {
    ...meta,
    header: {
      ...meta.header,
      title,
      metadata,
    },
  };
}

export function parseLlmContent(message: unknown): string {
  const payload = toRecord(message);
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) {
    const parts = payload.content
      .map((part) => {
        if (typeof part === "string") return part;
        const item = toRecord(part);
        if (typeof item.text === "string") return item.text;
        if (item.type === "text" && typeof item.value === "string") {
          return item.value;
        }
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  const content = toRecord(payload.content);
  if (typeof content.text === "string") return content.text;
  return "";
}

export async function requestSessionTitleFromLlm(input: {
  providerRegistry: LlmProviderRegistry;
  route: LlmResolvedRoute;
  messages: { role: string; content: string }[];
}): Promise<string> {
  const { providerRegistry, route, messages } = input;
  if (!messages.length) return "";
  const provider = providerRegistry.get(String(route.provider || "").trim());
  if (!provider) return "";

  const systemPrompt =
    "你是一个专业助手。请根据提供的对话内容，生成一个非常简短、精准的标题（不超过 10 个字）。直接返回标题文本，不要包含引号、序号或任何解释。";
  const userContent = messages
    .slice(0, 5)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${clipText(m.content, 200)}`)
    .join("\n");

  const llmTimeoutMs = normalizeIntInRange(
    route.llmTimeoutMs,
    DEFAULT_LLM_TIMEOUT_MS,
    MIN_LLM_TIMEOUT_MS,
    MAX_LLM_TIMEOUT_MS,
  );

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort("title-timeout"),
      Math.min(30_000, llmTimeoutMs),
    );
    try {
      const response = await provider.send({
        sessionId: "title-generator",
        step: 0,
        route,
        signal: ctrl.signal,
        payload: {
          model: route.llmModel,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `请总结以下对话的标题：\n\n${userContent}`,
            },
          ],
          max_tokens: 30,
          temperature: 0.3,
          stream: false,
        },
      });
      if (!response.ok) return "";
      const contentType = String(response.headers.get("content-type") || "");
      const rawBody = await response.text();
      const message = parseLlmMessageFromBody(rawBody, contentType);
      const title = normalizeSessionTitle(parseLlmContent(message), "").trim();
      return title
        .replace(/^[`"'“”‘’《》「」()（）【】\s]+/, "")
        .replace(/[`"'“”‘’《》「」()（）【】\s]+$/, "")
        .slice(0, 20);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("Failed to request session title:", error);
    return "";
  }
}

export async function refreshSessionTitleAuto(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  infra: RuntimeInfraHandler,
  providerRegistry: LlmProviderRegistry,
  options: { force?: boolean } = {},
): Promise<void> {
  const meta = await orchestrator.sessions.getMeta(sessionId);
  if (!meta) return;
  const currentTitle = normalizeSessionTitle(meta.header.title, "");
  const titleSource = readSessionTitleSource(meta);
  if (titleSource === SESSION_TITLE_SOURCE_MANUAL && !options.force) {
    return;
  }

  const entries = await orchestrator.sessions.getEntries(sessionId);
  const contextMessages = entries
    .filter((entry) => entry.type === "message")
    .map((entry: any) => ({
      role: String(entry.role),
      content: String(entry.text || ""),
    }))
    .filter((entry) => entry.content.trim().length > 0);

  const messageCount = contextMessages.length;
  if (messageCount === 0) return;

  const cfgRaw = await callInfra(infra, { type: "config.get" });
  const config = extractLlmConfig(cfgRaw);
  const resolvedRoute = resolveAuxiliaryLlmRoute(config);
  if (!resolvedRoute.ok) return;
  const route = resolvedRoute.route;
  const interval = config.autoTitleInterval;

  const isDefaultTitle =
    !currentTitle || currentTitle === "新会话" || currentTitle === "新对话";
  const shouldRefresh =
    options.force ||
    isDefaultTitle ||
    (interval > 0 && messageCount > 0 && messageCount % interval === 0);

  if (!shouldRefresh) return;

  const derived = await requestSessionTitleFromLlm({
    providerRegistry,
    route,
    messages: contextMessages,
  });
  if (!derived) return;

  const nextMeta = withSessionTitleMeta(
    meta,
    derived,
    SESSION_TITLE_SOURCE_AI,
  );
  await writeSessionMeta(sessionId, {
    ...nextMeta,
    updatedAt: new Date().toISOString(),
  });
  orchestrator.events.emit("session_title_auto_updated", sessionId, {
    title: derived,
  });
}
