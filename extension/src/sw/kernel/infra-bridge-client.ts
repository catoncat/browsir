/**
 * Bridge WebSocket client: connection management, config persistence, and invoke framing.
 * Extracted from runtime-infra.browser.ts to isolate WS communication concerns.
 */
import {
  normalizePanelConfig,
  type PanelConfigNew,
} from "../../shared/panel-config";

// ──────────────── types ────────────────

type JsonRecord = Record<string, unknown>;
export type BridgeConfig = PanelConfigNew;

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  sessionId: string;
}

// ──────────────── constants ────────────────

const DEFAULT_BRIDGE_TOKEN = "";
const DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS = 120_000;
const MAX_BRIDGE_INVOKE_TIMEOUT_MS = 300_000;
const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const MAX_LLM_TIMEOUT_MS = 300_000;
const DEFAULT_LLM_RETRY_MAX_ATTEMPTS = 2;
const MAX_LLM_RETRY_MAX_ATTEMPTS = 6;
const DEFAULT_LLM_MAX_RETRY_DELAY_MS = 60_000;
const MAX_LLM_MAX_RETRY_DELAY_MS = 300_000;

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
      "mcpServers",
      "mcpRefs",
      "browserRuntimeStrategy",
      "compaction",
      "llmProviders",
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
    bridgeConfigCache = normalizePanelConfig(data);
    return bridgeConfigCache;
  }

  async function saveBridgeConfig(payload: unknown): Promise<BridgeConfig> {
    const source = asRecord(payload);
    const current = await getBridgeConfig();
    const next: BridgeConfig = normalizePanelConfig({
      bridgeUrl:
        source.bridgeUrl !== undefined ? source.bridgeUrl : current.bridgeUrl,
      bridgeToken:
        source.bridgeToken !== undefined
          ? source.bridgeToken
          : current.bridgeToken,
      mcpServers:
        source.mcpServers !== undefined ? source.mcpServers : current.mcpServers,
      mcpRefs: source.mcpRefs !== undefined ? source.mcpRefs : current.mcpRefs,
      browserRuntimeStrategy:
        source.browserRuntimeStrategy !== undefined
          ? source.browserRuntimeStrategy
          : current.browserRuntimeStrategy,
      compaction:
        source.compaction !== undefined ? source.compaction : current.compaction,
      llmProviders:
        source.llmProviders !== undefined
          ? source.llmProviders
          : current.llmProviders,
      llmDefaultProfile:
        source.llmDefaultProfile !== undefined
          ? source.llmDefaultProfile
          : current.llmDefaultProfile,
      llmAuxProfile:
        source.llmAuxProfile !== undefined
          ? source.llmAuxProfile
          : current.llmAuxProfile,
      llmFallbackProfile:
        source.llmFallbackProfile !== undefined
          ? source.llmFallbackProfile
          : current.llmFallbackProfile,
      llmProfiles:
        source.llmProfiles !== undefined ? source.llmProfiles : current.llmProfiles,
      llmSystemPromptCustom:
        source.llmSystemPromptCustom !== undefined
          ? source.llmSystemPromptCustom
          : current.llmSystemPromptCustom,
      maxSteps: source.maxSteps !== undefined ? source.maxSteps : current.maxSteps,
      autoTitleInterval:
        source.autoTitleInterval !== undefined
          ? source.autoTitleInterval
          : current.autoTitleInterval,
      bridgeInvokeTimeoutMs:
        source.bridgeInvokeTimeoutMs !== undefined
          ? source.bridgeInvokeTimeoutMs
          : current.bridgeInvokeTimeoutMs,
      llmTimeoutMs:
        source.llmTimeoutMs !== undefined
          ? source.llmTimeoutMs
          : current.llmTimeoutMs,
      llmRetryMaxAttempts:
        source.llmRetryMaxAttempts !== undefined
          ? source.llmRetryMaxAttempts
          : current.llmRetryMaxAttempts,
      llmMaxRetryDelayMs:
        source.llmMaxRetryDelayMs !== undefined
          ? source.llmMaxRetryDelayMs
          : current.llmMaxRetryDelayMs,
      devAutoReload:
        source.devAutoReload !== undefined
          ? source.devAutoReload
          : current.devAutoReload,
      devReloadIntervalMs:
        source.devReloadIntervalMs !== undefined
          ? source.devReloadIntervalMs
          : current.devReloadIntervalMs,
    });
    await chrome.storage.local.set(next);
    await chrome.storage.local.remove([
      "llmProviderCatalog",
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
