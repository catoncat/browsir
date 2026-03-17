import type { BrainOrchestrator } from "./orchestrator.browser";
import type { LlmResolvedRoute } from "./llm-provider";
import { LlmProviderRegistry } from "./llm-provider-registry";
import type { RuntimeInfraHandler } from "./runtime-infra.browser";
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

const AUTO_TITLE_INITIAL_DONE_KEY = "autoTitleInitialDone";
const AUTO_TITLE_LAST_INTERVAL_COUNT_KEY = "autoTitleLastIntervalCount";

interface AutoTitleRefreshState {
  initialDone: boolean;
  lastIntervalCount: number;
}

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

function readAutoTitleRefreshState(meta: SessionMeta | null): AutoTitleRefreshState {
  const metadata = toRecord(meta?.header?.metadata);
  return {
    initialDone: metadata[AUTO_TITLE_INITIAL_DONE_KEY] === true,
    lastIntervalCount: normalizeIntInRange(
      metadata[AUTO_TITLE_LAST_INTERVAL_COUNT_KEY],
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function withAutoTitleRefreshState(
  meta: SessionMeta,
  state: AutoTitleRefreshState,
): SessionMeta {
  const current = readAutoTitleRefreshState(meta);
  if (
    current.initialDone === state.initialDone &&
    current.lastIntervalCount === state.lastIntervalCount
  ) {
    return meta;
  }
  const metadata = {
    ...toRecord(meta.header.metadata),
    [AUTO_TITLE_INITIAL_DONE_KEY]: state.initialDone,
    [AUTO_TITLE_LAST_INTERVAL_COUNT_KEY]: state.lastIntervalCount,
  };
  return {
    ...meta,
    header: {
      ...meta.header,
      metadata,
    },
  };
}

function planAutoTitleRefresh(input: {
  meta: SessionMeta;
  messageCount: number;
  interval: number;
  force: boolean;
}): { shouldRefresh: boolean; nextState: AutoTitleRefreshState } {
  const state = readAutoTitleRefreshState(input.meta);
  const intervalMilestone =
    input.interval > 0
      ? Math.floor(input.messageCount / input.interval) * input.interval
      : 0;

  if (input.force) {
    return {
      shouldRefresh: input.messageCount > 0,
      nextState: {
        initialDone: state.initialDone || input.messageCount > 0,
        lastIntervalCount: Math.max(state.lastIntervalCount, intervalMilestone),
      },
    };
  }

  const shouldDoInitial = !state.initialDone && input.messageCount > 0;
  const shouldDoInterval =
    input.interval > 0 &&
    intervalMilestone > 0 &&
    intervalMilestone > state.lastIntervalCount;

  return {
    shouldRefresh: shouldDoInitial || shouldDoInterval,
    nextState: {
      initialDone: state.initialDone || shouldDoInitial,
      lastIntervalCount: Math.max(state.lastIntervalCount, intervalMilestone),
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
  sessionId: string;
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
        sessionId: String(input.sessionId || "").trim() || "title-generator",
        step: 0,
        lane: "title",
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
  let shouldRefresh = false;
  let nextRefreshState: AutoTitleRefreshState | null = null;
  await orchestrator.sessions.updateMeta(sessionId, (latestMeta) => {
    if (readSessionTitleSource(latestMeta) === SESSION_TITLE_SOURCE_MANUAL && !options.force) {
      return latestMeta;
    }
    const plan = planAutoTitleRefresh({
      meta: latestMeta,
      messageCount,
      interval,
      force: options.force === true,
    });
    if (!plan.shouldRefresh) {
      return latestMeta;
    }
    shouldRefresh = true;
    nextRefreshState = plan.nextState;
    return withAutoTitleRefreshState(latestMeta, plan.nextState);
  });

  if (!shouldRefresh || !nextRefreshState) return;

  const derived = await requestSessionTitleFromLlm({
    sessionId,
    providerRegistry,
    route,
    messages: contextMessages,
  });
  if (!derived) return;

  let titleUpdated = false;
  await orchestrator.sessions.updateMeta(sessionId, (latestMeta) => {
    const latestTitle = normalizeSessionTitle(latestMeta.header.title, "");
    const latestSource = readSessionTitleSource(latestMeta);
    const scheduledMeta = withAutoTitleRefreshState(latestMeta, nextRefreshState!);
    if (latestTitle === derived && latestSource === SESSION_TITLE_SOURCE_AI) {
      return scheduledMeta;
    }
    titleUpdated = true;
    return withSessionTitleMeta(
      scheduledMeta,
      derived,
      SESSION_TITLE_SOURCE_AI,
    );
  });
  if (titleUpdated || currentTitle !== derived) {
    orchestrator.events.emit("session_title_auto_updated", sessionId, {
      title: derived,
    });
  }
}
