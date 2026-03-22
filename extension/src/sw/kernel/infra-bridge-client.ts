/**
 * Bridge WebSocket client: connection management, config persistence, and invoke framing.
 * Extracted from runtime-infra.browser.ts to isolate WS communication concerns.
 */
import {
  normalizeBrowserRuntimeStrategy,
  type BrowserRuntimeStrategy,
} from "./browser-runtime-strategy";
import {
  normalizeCompactionSettings,
  type CompactionSettings,
} from "../../shared/compaction";
import { normalizeProviderConnectionConfig } from "../../shared/llm-provider-config";

// ──────────────── types ────────────────

type JsonRecord = Record<string, unknown>;

export interface BridgeConfig {
  bridgeUrl: string;
  bridgeToken: string;
  browserRuntimeStrategy: BrowserRuntimeStrategy;
  compaction: CompactionSettings;
  llmDefaultProfile?: string;
  llmAuxProfile?: string;
  llmFallbackProfile?: string;
  llmProfiles?: unknown;
  llmSystemPromptCustom?: string;
  maxSteps: number;
  autoTitleInterval: number;
  bridgeInvokeTimeoutMs: number;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
  devAutoReload: boolean;
  devReloadIntervalMs: number;
}

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  sessionId: string;
}

// ──────────────── constants ────────────────

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8787/ws";
const DEFAULT_BRIDGE_TOKEN = "";
const DEFAULT_BROWSER_RUNTIME_STRATEGY: BrowserRuntimeStrategy = "browser-first";
const DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS = 120_000;
const MAX_BRIDGE_INVOKE_TIMEOUT_MS = 300_000;
const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const MAX_LLM_TIMEOUT_MS = 300_000;
const DEFAULT_LLM_RETRY_MAX_ATTEMPTS = 2;
const MAX_LLM_RETRY_MAX_ATTEMPTS = 6;
const DEFAULT_LLM_MAX_RETRY_DELAY_MS = 60_000;
const MAX_LLM_MAX_RETRY_DELAY_MS = 300_000;
const MAX_CUSTOM_SYSTEM_PROMPT_CHARS = 12_000;
const BUILTIN_CURSOR_HELP_PROFILE_ID = "cursor_help_web";
const BUILTIN_CURSOR_HELP_PROVIDER_ID = "cursor_help_web";
const BUILTIN_CURSOR_HELP_MODEL_ID = "auto";

// ──────────────── pure helpers ────────────────

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix = "id"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function toIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function toOptionalFiniteNumber(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function normalizeCustomSystemPrompt(raw: unknown, fallback = ""): string {
  if (raw == null) return String(fallback || "");
  const text = String(raw);
  if (!text.trim()) return "";
  if (text.length <= MAX_CUSTOM_SYSTEM_PROMPT_CHARS) return text;
  return text.slice(0, MAX_CUSTOM_SYSTEM_PROMPT_CHARS);
}

function normalizeStoredLlmProfiles(raw: unknown): unknown {
  const source = Array.isArray(raw) ? raw : [];
  const normalized: JsonRecord[] = source.map((item) => {
    const row = asRecord(item);
    const { role: _role, ...rest } = row;
    const connection = normalizeProviderConnectionConfig({
      provider: row.provider,
      llmApiBase: row.llmApiBase,
      llmApiKey: row.llmApiKey,
    });
    return {
      ...rest,
      llmApiBase: connection.llmApiBase,
      llmApiKey: connection.llmApiKey,
    };
  });
  if (
    !normalized.some(
      (item) => String(asRecord(item).id || "").trim() === BUILTIN_CURSOR_HELP_PROFILE_ID,
    )
  ) {
    normalized.push({
      id: BUILTIN_CURSOR_HELP_PROFILE_ID,
      provider: BUILTIN_CURSOR_HELP_PROVIDER_ID,
      llmApiBase: "",
      llmApiKey: "",
      llmModel: BUILTIN_CURSOR_HELP_MODEL_ID,
      providerOptions: {
        targetSite: "cursor_help",
      },
    });
  }
  return normalized;
}

function collectStoredProfileIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(raw)) return ids;
  for (const item of raw) {
    const id = String(asRecord(item).id || "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

function normalizeOptionalProfileId(
  raw: unknown,
  defaultProfile: string,
  validIds: Set<string>,
): string {
  const id = String(raw || "").trim();
  if (!id || id === defaultProfile) return "";
  if (validIds.size > 0 && !validIds.has(id)) return "";
  return id;
}

function resolveStoredDefaultProfileId(
  raw: unknown,
  validIds: Set<string>,
): string {
  const requested = String(raw || "").trim();
  if (requested && validIds.has(requested)) return requested;
  if (validIds.has(BUILTIN_CURSOR_HELP_PROFILE_ID)) {
    return BUILTIN_CURSOR_HELP_PROFILE_ID;
  }
  const first = validIds.values().next();
  if (!first.done && String(first.value || "").trim()) {
    return String(first.value || "").trim();
  }
  return requested || "default";
}

export function isRetryableBridgeCode(code: string): boolean {
  return [
    "E_BUSY",
    "E_TIMEOUT",
    "E_CLIENT_TIMEOUT",
    "E_BRIDGE_DISCONNECTED",
  ].includes(String(code || "").toUpperCase());
}

export function asBridgeInvokeError(
  message: string,
  meta: {
    code?: string;
    details?: unknown;
    retryable?: boolean;
    status?: number;
  } = {},
): Error & { code?: string; details?: unknown; retryable?: boolean; status?: number } {
  const error = new Error(message) as Error & {
    code?: string;
    details?: unknown;
    retryable?: boolean;
    status?: number;
  };
  if (meta.code) error.code = meta.code;
  if (meta.details !== undefined) error.details = meta.details;
  if (typeof meta.retryable === "boolean") error.retryable = meta.retryable;
  if (typeof meta.status === "number") error.status = meta.status;
  return error;
}

function readInvokeTimeoutHint(frame: JsonRecord): number | null {
  const direct = toOptionalFiniteNumber(frame.timeoutMs);
  if (direct !== null) return direct;
  const nested = toOptionalFiniteNumber(asRecord(frame.args).timeoutMs);
  return nested;
}

// ──────────────── factory ────────────────

export interface BridgeClient {
  disconnectBridge(): void;
  abortBridgeInvokesBySession(rawSessionId: unknown, rawReason?: unknown): number;
  getBridgeConfig(): Promise<BridgeConfig>;
  saveBridgeConfig(payload: unknown): Promise<BridgeConfig>;
  connectBridge(force?: boolean): Promise<WebSocket>;
  invokeBridge(frame: unknown): Promise<unknown>;
}

export function createBridgeClient(): BridgeClient {
  let bridgeSocket: WebSocket | null = null;
  let bridgeConnected = false;
  let bridgeConnectPromise: Promise<WebSocket> | null = null;
  let bridgeConfigCache: BridgeConfig | null = null;
  const pendingInvokes = new Map<string, PendingInvoke>();

  function broadcast(message: JsonRecord): void {
    chrome.runtime.sendMessage(message).catch(() => {
      // sidepanel/debug may be closed
    });
  }

  function resetBridgeSocket(options: { skipClose?: boolean } = {}): void {
    const currentSocket = bridgeSocket;
    bridgeConnected = false;
    bridgeConnectPromise = null;
    bridgeSocket = null;

    if (currentSocket && options.skipClose !== true) {
      try {
        currentSocket.onopen = null;
        currentSocket.onmessage = null;
        currentSocket.onerror = null;
        currentSocket.onclose = null;
        if (
          currentSocket.readyState === WebSocket.OPEN ||
          currentSocket.readyState === WebSocket.CONNECTING
        ) {
          currentSocket.close();
        }
      } catch {
        // ignore close failures
      }
    }

    for (const pending of pendingInvokes.values()) {
      pending.reject(
        asBridgeInvokeError("Bridge disconnected", {
          code: "E_BRIDGE_DISCONNECTED",
          retryable: true,
        }),
      );
    }
    pendingInvokes.clear();
  }

  function abortBridgeInvokesBySession(
    rawSessionId: unknown,
    rawReason: unknown = "stop",
  ): number {
    const sessionId = String(rawSessionId || "").trim();
    if (!sessionId) return 0;
    const reason =
      String(rawReason || "")
        .trim()
        .toLowerCase() === "steer_preempt"
        ? "steer_preempt"
        : "stop";
    let aborted = 0;
    for (const [id, pending] of pendingInvokes.entries()) {
      if (pending.sessionId !== sessionId) continue;
      pendingInvokes.delete(id);
      clearTimeout(pending.timeout);
      const interruptedBySteer = reason === "steer_preempt";
      pending.reject(
        asBridgeInvokeError(
          interruptedBySteer
            ? "Bridge invoke interrupted by steer promote request"
            : "Bridge invoke aborted by stop request",
          {
            code: interruptedBySteer
              ? "E_BRIDGE_INTERRUPTED"
              : "E_BRIDGE_ABORTED",
            details: { sessionId, reason },
            retryable: false,
          },
        ),
      );
      aborted += 1;
    }
    return aborted;
  }

  function onBridgeMessage(raw: MessageEvent): void {
    let message: JsonRecord | null = null;
    try {
      message = JSON.parse(String(raw.data || "")) as JsonRecord;
    } catch {
      return;
    }
    if (!message) return;

    if (message.type === "event") {
      broadcast({ type: "bridge.event", payload: message });
      return;
    }

    const id = String(message.id || "");
    if (!id) return;
    const pending = pendingInvokes.get(id);
    if (!pending) return;
    pendingInvokes.delete(id);
    clearTimeout(pending.timeout);

    if (message.ok === true) {
      pending.resolve(message);
      return;
    }
    const errorPayload = asRecord(message.error);
    const code =
      typeof errorPayload.code === "string"
        ? errorPayload.code.trim().toUpperCase()
        : "";
    const err = asBridgeInvokeError(
      String(errorPayload.message || "Bridge invoke failed"),
      {
        code: code || undefined,
        details: errorPayload.details,
        retryable: code ? isRetryableBridgeCode(code) : undefined,
      },
    );
    pending.reject(err);
  }

  async function getBridgeConfig(): Promise<BridgeConfig> {
    if (bridgeConfigCache) return bridgeConfigCache;
    const data = await chrome.storage.local.get([
      "bridgeUrl",
      "bridgeToken",
      "browserRuntimeStrategy",
      "compaction",
      "llmDefaultProfile",
      "llmAuxProfile",
      "llmFallbackProfile",
      "llmProfiles",
      "llmSystemPromptCustom",
      "maxSteps",
      "autoTitleInterval",
      "bridgeInvokeTimeoutMs",
      "llmTimeoutMs",
      "llmRetryMaxAttempts",
      "llmMaxRetryDelayMs",
      "devAutoReload",
      "devReloadIntervalMs",
    ]);
    const llmProfiles = normalizeStoredLlmProfiles(data.llmProfiles);
    const validProfileIds = collectStoredProfileIds(llmProfiles);
    const llmDefaultProfile = resolveStoredDefaultProfileId(
      data.llmDefaultProfile,
      validProfileIds,
    );
    bridgeConfigCache = {
      bridgeUrl: String(data.bridgeUrl || DEFAULT_BRIDGE_URL),
      bridgeToken: String(data.bridgeToken || DEFAULT_BRIDGE_TOKEN),
      browserRuntimeStrategy: normalizeBrowserRuntimeStrategy(
        data.browserRuntimeStrategy,
        DEFAULT_BROWSER_RUNTIME_STRATEGY,
      ),
      compaction: normalizeCompactionSettings(data.compaction),
      llmDefaultProfile,
      llmAuxProfile: normalizeOptionalProfileId(
        data.llmAuxProfile,
        llmDefaultProfile,
        validProfileIds,
      ),
      llmFallbackProfile: normalizeOptionalProfileId(
        data.llmFallbackProfile,
        llmDefaultProfile,
        validProfileIds,
      ),
      llmProfiles,
      llmSystemPromptCustom: normalizeCustomSystemPrompt(
        data.llmSystemPromptCustom,
        "",
      ),
      maxSteps: toIntInRange(data.maxSteps, 100, 1, 500),
      autoTitleInterval: toIntInRange(data.autoTitleInterval, 10, 0, 100),
      bridgeInvokeTimeoutMs: toIntInRange(
        data.bridgeInvokeTimeoutMs,
        DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS,
        1_000,
        MAX_BRIDGE_INVOKE_TIMEOUT_MS,
      ),
      llmTimeoutMs: toIntInRange(
        data.llmTimeoutMs,
        DEFAULT_LLM_TIMEOUT_MS,
        1_000,
        MAX_LLM_TIMEOUT_MS,
      ),
      llmRetryMaxAttempts: toIntInRange(
        data.llmRetryMaxAttempts,
        DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
        0,
        MAX_LLM_RETRY_MAX_ATTEMPTS,
      ),
      llmMaxRetryDelayMs: toIntInRange(
        data.llmMaxRetryDelayMs,
        DEFAULT_LLM_MAX_RETRY_DELAY_MS,
        0,
        MAX_LLM_MAX_RETRY_DELAY_MS,
      ),
      devAutoReload: data.devAutoReload === true,
      devReloadIntervalMs: Number.isFinite(Number(data.devReloadIntervalMs))
        ? Number(data.devReloadIntervalMs)
        : 1500,
    };
    return bridgeConfigCache;
  }

  async function saveBridgeConfig(payload: unknown): Promise<BridgeConfig> {
    const source = asRecord(payload);
    const current = await getBridgeConfig();
    const llmProfiles = normalizeStoredLlmProfiles(
      source.llmProfiles !== undefined
        ? source.llmProfiles
        : current.llmProfiles,
    );
    const validProfileIds = collectStoredProfileIds(llmProfiles);
    const llmDefaultProfile = resolveStoredDefaultProfileId(
      source.llmDefaultProfile !== undefined
        ? source.llmDefaultProfile
        : current.llmDefaultProfile,
      validProfileIds,
    );
    const next: BridgeConfig = {
      bridgeUrl: String(
        source.bridgeUrl || current.bridgeUrl || DEFAULT_BRIDGE_URL,
      ).trim(),
      bridgeToken: String(
        source.bridgeToken ?? current.bridgeToken ?? DEFAULT_BRIDGE_TOKEN,
      ),
      browserRuntimeStrategy: normalizeBrowserRuntimeStrategy(
        source.browserRuntimeStrategy,
        current.browserRuntimeStrategy || DEFAULT_BROWSER_RUNTIME_STRATEGY,
      ),
      compaction: normalizeCompactionSettings(
        source.compaction ?? current.compaction,
        current.compaction,
      ),
      llmDefaultProfile,
      llmAuxProfile: normalizeOptionalProfileId(
        source.llmAuxProfile !== undefined
          ? source.llmAuxProfile
          : current.llmAuxProfile,
        llmDefaultProfile,
        validProfileIds,
      ),
      llmFallbackProfile: normalizeOptionalProfileId(
        source.llmFallbackProfile !== undefined
          ? source.llmFallbackProfile
          : current.llmFallbackProfile,
        llmDefaultProfile,
        validProfileIds,
      ),
      llmProfiles,
      llmSystemPromptCustom: normalizeCustomSystemPrompt(
        source.llmSystemPromptCustom,
        current.llmSystemPromptCustom || "",
      ),
      maxSteps: toIntInRange(source.maxSteps, current.maxSteps || 100, 1, 500),
      autoTitleInterval: toIntInRange(
        source.autoTitleInterval,
        current.autoTitleInterval ?? 10,
        0,
        100,
      ),
      bridgeInvokeTimeoutMs: toIntInRange(
        source.bridgeInvokeTimeoutMs,
        current.bridgeInvokeTimeoutMs || DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS,
        1_000,
        MAX_BRIDGE_INVOKE_TIMEOUT_MS,
      ),
      llmTimeoutMs: toIntInRange(
        source.llmTimeoutMs,
        current.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS,
        1_000,
        MAX_LLM_TIMEOUT_MS,
      ),
      llmRetryMaxAttempts: toIntInRange(
        source.llmRetryMaxAttempts,
        current.llmRetryMaxAttempts || DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
        0,
        MAX_LLM_RETRY_MAX_ATTEMPTS,
      ),
      llmMaxRetryDelayMs: toIntInRange(
        source.llmMaxRetryDelayMs,
        current.llmMaxRetryDelayMs || DEFAULT_LLM_MAX_RETRY_DELAY_MS,
        0,
        MAX_LLM_MAX_RETRY_DELAY_MS,
      ),
      devAutoReload:
        source.devAutoReload === undefined
          ? current.devAutoReload
          : source.devAutoReload === true,
      devReloadIntervalMs: Math.max(
        500,
        Number(
          source.devReloadIntervalMs || current.devReloadIntervalMs || 1500,
        ),
      ),
    };
    await chrome.storage.local.set(next);
    await chrome.storage.local.remove([
      "llmProfileChains",
      "llmEscalationPolicy",
    ]);
    bridgeConfigCache = next;
    return next;
  }

  async function connectBridge(force = false): Promise<WebSocket> {
    if (
      bridgeConnected &&
      bridgeSocket &&
      bridgeSocket.readyState === WebSocket.OPEN &&
      !force
    ) {
      return bridgeSocket;
    }
    if (bridgeConnectPromise && !force) return bridgeConnectPromise;

    bridgeConnectPromise = (async () => {
      const config = await getBridgeConfig();
      const wsUrl = new URL(config.bridgeUrl);
      if (String(config.bridgeToken || "").trim()) {
        wsUrl.searchParams.set("token", config.bridgeToken);
      } else {
        wsUrl.searchParams.delete("token");
      }
      const wsHref = wsUrl.toString();

      return await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(wsHref);
        let settled = false;
        const rejectOnce = (error: Error): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };

        ws.onopen = () => {
          settled = true;
          bridgeSocket = ws;
          bridgeConnected = true;
          broadcast({
            type: "bridge.status",
            status: "connected",
            at: nowIso(),
          });
          resolve(ws);
        };
        ws.onmessage = onBridgeMessage;
        ws.onerror = (event) => {
          if (!bridgeConnected) {
            rejectOnce(
              new Error(
                `Bridge connection failed: ${event.type}; url=${wsHref}`,
              ),
            );
          }
        };
        ws.onclose = (event) => {
          broadcast({
            type: "bridge.status",
            status: "disconnected",
            at: nowIso(),
          });
          if (!settled) {
            const reason = event.reason ? ` reason=${event.reason}` : "";
            rejectOnce(
              new Error(
                `Bridge closed before ready: code=${event.code}${reason}; url=${wsHref}`,
              ),
            );
          }
          resetBridgeSocket({ skipClose: true });
        };
      });
    })();

    try {
      return await bridgeConnectPromise;
    } finally {
      bridgeConnectPromise = null;
    }
  }

  async function invokeBridge(frame: unknown): Promise<unknown> {
    const ws = await connectBridge();
    const config = await getBridgeConfig();
    const payloadFrame = asRecord(frame);
    const id = String(payloadFrame.id || randomId("invoke"));
    const hintTimeout = readInvokeTimeoutHint(payloadFrame);
    const timeoutMs = toIntInRange(
      hintTimeout == null
        ? config.bridgeInvokeTimeoutMs
        : Math.max(
            config.bridgeInvokeTimeoutMs,
            Math.floor(hintTimeout) + 2_000,
          ),
      config.bridgeInvokeTimeoutMs,
      1_000,
      MAX_BRIDGE_INVOKE_TIMEOUT_MS,
    );
    const payload = {
      id,
      type: "invoke",
      tool: payloadFrame.tool,
      args: asRecord(payloadFrame.args),
      sessionId: payloadFrame.sessionId,
      parentSessionId: payloadFrame.parentSessionId,
      agentId: payloadFrame.agentId,
    };
    return await new Promise((resolve, reject) => {
      const pendingSessionId = String(payload.sessionId || "").trim();
      const timeout = setTimeout(() => {
        pendingInvokes.delete(id);
        reject(
          asBridgeInvokeError(`Bridge invoke timeout after ${timeoutMs}ms`, {
            code: "E_CLIENT_TIMEOUT",
            details: {
              timeoutMs,
              requestedTimeoutMs: hintTimeout,
              tool: String(payload.tool || ""),
            },
            retryable: true,
          }),
        );
      }, timeoutMs);
      pendingInvokes.set(id, {
        resolve,
        reject,
        timeout,
        sessionId: pendingSessionId,
      });
      ws.send(JSON.stringify(payload));
    });
  }

  return {
    disconnectBridge: resetBridgeSocket,
    abortBridgeInvokesBySession,
    getBridgeConfig,
    saveBridgeConfig,
    connectBridge,
    invokeBridge,
  };
}
