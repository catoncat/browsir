const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8787/ws";
const DEFAULT_BRIDGE_TOKEN = "dev-token-change-me";
const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS = 120_000;
const MAX_BRIDGE_INVOKE_TIMEOUT_MS = 300_000;
const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const MAX_LLM_TIMEOUT_MS = 300_000;
const DEFAULT_LLM_RETRY_MAX_ATTEMPTS = 2;
const MAX_LLM_RETRY_MAX_ATTEMPTS = 6;
const DEFAULT_LLM_MAX_RETRY_DELAY_MS = 60_000;
const MAX_LLM_MAX_RETRY_DELAY_MS = 300_000;

type JsonRecord = Record<string, unknown>;

export interface BridgeConfig {
  bridgeUrl: string;
  bridgeToken: string;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  llmDefaultProfile?: string;
  llmProfiles?: unknown;
  llmProfileChains?: unknown;
  llmEscalationPolicy?: string;
  maxSteps: number;
  autoTitleInterval: number;
  bridgeInvokeTimeoutMs: number;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
  devAutoReload: boolean;
  devReloadIntervalMs: number;
}

export interface RuntimeOk<T = unknown> {
  ok: true;
  data?: T;
}

export interface RuntimeErr {
  ok: false;
  error: string;
  code?: string;
  details?: unknown;
  retryable?: boolean;
  status?: number;
}

export type RuntimeInfraResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

export interface RuntimeInfraHandler {
  handleMessage(message: unknown): Promise<RuntimeInfraResult | null>;
  disconnectBridge(): void;
}

interface LeaseState {
  tabId: number;
  owner: string;
  leaseId: string;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SnapshotState {
  byKey: Map<string, JsonRecord>;
  refMap: Map<string, JsonRecord>;
  lastSnapshotId: string | null;
}

interface TelemetryState {
  console: JsonRecord[];
  network: JsonRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix = "id"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashText(input: unknown): string {
  const text = String(input ?? "");
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function toValidTabId(raw: unknown): number | null {
  const tabId = Number(raw);
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  return tabId;
}

function toPositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
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

function normalizeOwner(raw: unknown): string {
  const owner = typeof raw === "string" ? raw.trim() : "";
  if (!owner) {
    throw new Error("owner is required for lease/cdp.action");
  }
  return owner;
}

function normalizeLeaseTtl(rawTtl: unknown): number {
  const ttl = toPositiveInt(rawTtl, DEFAULT_LEASE_TTL_MS);
  return Math.max(2000, Math.min(MAX_LEASE_TTL_MS, ttl));
}

function resolveOwnerFromMessage(message: unknown): string {
  const msg = asRecord(message);
  return String(msg.owner || msg.sessionId || msg.agentId || "");
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function ok<T>(data?: T): RuntimeInfraResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): RuntimeInfraResult {
  if (error instanceof Error) {
    const enriched = error as Error & {
      code?: unknown;
      details?: unknown;
      retryable?: unknown;
      status?: unknown;
    };
    const out: RuntimeErr = {
      ok: false,
      error: error.message
    };
    if (typeof enriched.code === "string" && enriched.code.trim()) out.code = enriched.code.trim();
    if (enriched.details !== undefined) out.details = enriched.details;
    if (typeof enriched.retryable === "boolean") out.retryable = enriched.retryable;
    if (Number.isFinite(Number(enriched.status))) out.status = Number(enriched.status);
    return out;
  }
  return { ok: false, error: String(error) };
}

function isRetryableBridgeCode(code: string): boolean {
  return ["E_BUSY", "E_TIMEOUT", "E_CLIENT_TIMEOUT", "E_BRIDGE_DISCONNECTED"].includes(String(code || "").toUpperCase());
}

function asBridgeInvokeError(
  message: string,
  meta: {
    code?: string;
    details?: unknown;
    retryable?: boolean;
    status?: number;
  } = {}
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

function snapshotKey(options: JsonRecord): string {
  return [
    String(options.mode || "interactive"),
    String(options.filter || "interactive"),
    String(options.selector || "__root__"),
    String(options.depth ?? "-1"),
    String(options.maxTokens ?? "1200"),
    String(options.maxNodes ?? "120")
  ].join(":");
}

function summarizeSnapshotNode(node: JsonRecord): string {
  return `${String(node.role || "")}|${String(node.name || "")}|${String(node.selector || "")}|${String(node.value || "")}`;
}

function formatNodeCompact(node: JsonRecord): string {
  const role = String(node.role || "node");
  const label = String(node.name || node.value || "").replace(/\s+/g, " ").trim();
  const showLabel = label ? ` "${label.slice(0, 80)}"` : "";
  const flags: string[] = [];
  if (node.disabled) flags.push("disabled");
  if (node.focused) flags.push("focused");
  if (node.selector) flags.push(`sel=${String(node.selector).slice(0, 36)}`);
  const flagText = flags.length > 0 ? ` [${flags.join(",")}]` : "";
  return `${String(node.ref || "")}:${role}${showLabel}${flagText}`;
}

function buildCompactSnapshot(snapshot: JsonRecord): string {
  if (snapshot.mode === "text") {
    return `# ${String(snapshot.title || "")} | ${String(snapshot.url || "")}\n${String(snapshot.text || "")}`;
  }
  const lines = [
    `# ${String(snapshot.title || "")} | ${String(snapshot.url || "")} | ${Number(snapshot.count || 0)} nodes`
  ];
  const nodes = Array.isArray(snapshot.nodes) ? (snapshot.nodes as JsonRecord[]) : [];
  for (const node of nodes) {
    lines.push(formatNodeCompact(node));
  }
  return lines.join("\n");
}

function actionRequiresLease(kind: string): boolean {
  return ["click", "type", "fill", "press", "scroll", "select", "navigate"].includes(kind);
}

function normalizeActionKind(rawKind: unknown): string {
  const kind = typeof rawKind === "string" ? rawKind.trim() : "";
  if (!kind) throw new Error("action.kind is required");
  return kind;
}

function normalizeSnapshotOptions(raw: JsonRecord = {}): JsonRecord {
  const modeRaw = String(raw.mode || "").trim();
  const mode = modeRaw === "text" || modeRaw === "full" || modeRaw === "interactive" ? modeRaw : "interactive";
  const filterRaw = String(raw.filter || "").trim();
  const filter = mode === "text" ? "all" : filterRaw === "all" ? "all" : "interactive";
  const format = String(raw.format || "json") === "compact" ? "compact" : "json";
  const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
  const diff = raw.diff !== false;
  const noAnimations = raw.noAnimations === true;
  const maxNodesFallback = mode === "full" ? 260 : 120;
  const maxTokensFallback = mode === "text" ? 1800 : 1200;
  const depthRaw = Number(raw.depth);
  const depth = Number.isInteger(depthRaw) && depthRaw >= 0 ? depthRaw : -1;
  return {
    mode,
    filter,
    format,
    selector,
    diff,
    noAnimations,
    depth,
    maxTokens: Math.max(120, Math.min(12_000, toPositiveInt(raw.maxTokens, maxTokensFallback))),
    maxNodes: Math.max(20, Math.min(1000, toPositiveInt(raw.maxNodes, maxNodesFallback))),
    maxChars: Math.max(200, Math.min(12_000, toPositiveInt(raw.maxChars, 4000)))
  };
}

export function createRuntimeInfraHandler(): RuntimeInfraHandler {
  let bridgeSocket: WebSocket | null = null;
  let bridgeConnected = false;
  let bridgeConnectPromise: Promise<WebSocket> | null = null;
  let bridgeConfigCache: BridgeConfig | null = null;

  const pendingInvokes = new Map<string, PendingInvoke>();
  const leaseByTab = new Map<number, LeaseState>();
  const attachedTabs = new Set<number>();
  const telemetryByTab = new Map<number, TelemetryState>();
  const snapshotStateByTab = new Map<number, SnapshotState>();
  let debuggerHooksInstalled = false;

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
        if (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING) {
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
          retryable: true
        })
      );
    }
    pendingInvokes.clear();
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
    const code = typeof errorPayload.code === "string" ? errorPayload.code.trim().toUpperCase() : "";
    const err = asBridgeInvokeError(String(errorPayload.message || "Bridge invoke failed"), {
      code: code || undefined,
      details: errorPayload.details,
      retryable: code ? isRetryableBridgeCode(code) : undefined
    });
    pending.reject(err);
  }

  async function getBridgeConfig(): Promise<BridgeConfig> {
    if (bridgeConfigCache) return bridgeConfigCache;
    const data = await chrome.storage.local.get([
      "bridgeUrl",
      "bridgeToken",
      "llmApiBase",
      "llmApiKey",
      "llmModel",
      "llmDefaultProfile",
      "llmProfiles",
      "llmProfileChains",
      "llmEscalationPolicy",
      "maxSteps",
      "autoTitleInterval",
      "bridgeInvokeTimeoutMs",
      "llmTimeoutMs",
      "llmRetryMaxAttempts",
      "llmMaxRetryDelayMs",
      "devAutoReload",
      "devReloadIntervalMs"
    ]);
    bridgeConfigCache = {
      bridgeUrl: String(data.bridgeUrl || DEFAULT_BRIDGE_URL),
      bridgeToken: String(data.bridgeToken || DEFAULT_BRIDGE_TOKEN),
      llmApiBase: String(data.llmApiBase || "https://ai.chen.rs/v1"),
      llmApiKey: String(data.llmApiKey || ""),
      llmModel: String(data.llmModel || "gpt-5.3-codex"),
      llmDefaultProfile: String(data.llmDefaultProfile || "default"),
      llmProfiles: data.llmProfiles,
      llmProfileChains: data.llmProfileChains,
      llmEscalationPolicy: String(data.llmEscalationPolicy || "upgrade_only"),
      maxSteps: toIntInRange(data.maxSteps, 100, 1, 500),
      autoTitleInterval: toIntInRange(data.autoTitleInterval, 10, 0, 100),
      bridgeInvokeTimeoutMs: toIntInRange(
        data.bridgeInvokeTimeoutMs,
        DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS,
        1_000,
        MAX_BRIDGE_INVOKE_TIMEOUT_MS
      ),
      llmTimeoutMs: toIntInRange(data.llmTimeoutMs, DEFAULT_LLM_TIMEOUT_MS, 1_000, MAX_LLM_TIMEOUT_MS),
      llmRetryMaxAttempts: toIntInRange(
        data.llmRetryMaxAttempts,
        DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
        0,
        MAX_LLM_RETRY_MAX_ATTEMPTS
      ),
      llmMaxRetryDelayMs: toIntInRange(
        data.llmMaxRetryDelayMs,
        DEFAULT_LLM_MAX_RETRY_DELAY_MS,
        0,
        MAX_LLM_MAX_RETRY_DELAY_MS
      ),
      devAutoReload: data.devAutoReload !== false,
      devReloadIntervalMs: Number.isFinite(Number(data.devReloadIntervalMs)) ? Number(data.devReloadIntervalMs) : 1500
    };
    return bridgeConfigCache;
  }

  async function saveBridgeConfig(payload: unknown): Promise<BridgeConfig> {
    const source = asRecord(payload);
    const current = await getBridgeConfig();
    const next: BridgeConfig = {
      bridgeUrl: String(source.bridgeUrl || current.bridgeUrl || DEFAULT_BRIDGE_URL).trim(),
      bridgeToken: String(source.bridgeToken ?? current.bridgeToken ?? DEFAULT_BRIDGE_TOKEN),
      llmApiBase: String(source.llmApiBase || current.llmApiBase || "https://ai.chen.rs/v1").trim(),
      llmApiKey: String(source.llmApiKey ?? current.llmApiKey ?? ""),
      llmModel: String(source.llmModel || current.llmModel || "gpt-5.3-codex").trim(),
      llmDefaultProfile: String(source.llmDefaultProfile || current.llmDefaultProfile || "default").trim() || "default",
      llmProfiles: source.llmProfiles !== undefined ? source.llmProfiles : current.llmProfiles,
      llmProfileChains: source.llmProfileChains !== undefined ? source.llmProfileChains : current.llmProfileChains,
      llmEscalationPolicy: String(source.llmEscalationPolicy || current.llmEscalationPolicy || "upgrade_only").trim() || "upgrade_only",
      maxSteps: toIntInRange(source.maxSteps, current.maxSteps || 100, 1, 500),
      autoTitleInterval: toIntInRange(source.autoTitleInterval, current.autoTitleInterval ?? 10, 0, 100),
      bridgeInvokeTimeoutMs: toIntInRange(
        source.bridgeInvokeTimeoutMs,
        current.bridgeInvokeTimeoutMs || DEFAULT_BRIDGE_INVOKE_TIMEOUT_MS,
        1_000,
        MAX_BRIDGE_INVOKE_TIMEOUT_MS
      ),
      llmTimeoutMs: toIntInRange(source.llmTimeoutMs, current.llmTimeoutMs || DEFAULT_LLM_TIMEOUT_MS, 1_000, MAX_LLM_TIMEOUT_MS),
      llmRetryMaxAttempts: toIntInRange(
        source.llmRetryMaxAttempts,
        current.llmRetryMaxAttempts || DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
        0,
        MAX_LLM_RETRY_MAX_ATTEMPTS
      ),
      llmMaxRetryDelayMs: toIntInRange(
        source.llmMaxRetryDelayMs,
        current.llmMaxRetryDelayMs || DEFAULT_LLM_MAX_RETRY_DELAY_MS,
        0,
        MAX_LLM_MAX_RETRY_DELAY_MS
      ),
      devAutoReload: source.devAutoReload === undefined ? current.devAutoReload : source.devAutoReload !== false,
      devReloadIntervalMs: Math.max(500, Number(source.devReloadIntervalMs || current.devReloadIntervalMs || 1500))
    };
    await chrome.storage.local.set(next);
    bridgeConfigCache = next;
    return next;
  }

  async function connectBridge(force = false): Promise<WebSocket> {
    if (bridgeConnected && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN && !force) {
      return bridgeSocket;
    }
    if (bridgeConnectPromise && !force) return bridgeConnectPromise;

    bridgeConnectPromise = (async () => {
      const config = await getBridgeConfig();
      const wsUrl = new URL(config.bridgeUrl);
      wsUrl.searchParams.set("token", config.bridgeToken);
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
          broadcast({ type: "bridge.status", status: "connected", at: nowIso() });
          resolve(ws);
        };
        ws.onmessage = onBridgeMessage;
        ws.onerror = (event) => {
          if (!bridgeConnected) {
            rejectOnce(new Error(`Bridge connection failed: ${event.type}; url=${wsHref}`));
          }
        };
        ws.onclose = (event) => {
          broadcast({ type: "bridge.status", status: "disconnected", at: nowIso() });
          if (!settled) {
            const reason = event.reason ? ` reason=${event.reason}` : "";
            rejectOnce(new Error(`Bridge closed before ready: code=${event.code}${reason}; url=${wsHref}`));
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
        : Math.max(config.bridgeInvokeTimeoutMs, Math.floor(hintTimeout) + 2_000),
      config.bridgeInvokeTimeoutMs,
      1_000,
      MAX_BRIDGE_INVOKE_TIMEOUT_MS
    );
    const payload = {
      id,
      type: "invoke",
      tool: payloadFrame.tool,
      args: asRecord(payloadFrame.args),
      sessionId: payloadFrame.sessionId,
      parentSessionId: payloadFrame.parentSessionId,
      agentId: payloadFrame.agentId
    };
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingInvokes.delete(id);
        reject(
          asBridgeInvokeError(`Bridge invoke timeout after ${timeoutMs}ms`, {
            code: "E_CLIENT_TIMEOUT",
            details: {
              timeoutMs,
              requestedTimeoutMs: hintTimeout,
              tool: String(payload.tool || "")
            },
            retryable: true
          })
        );
      }, timeoutMs);
      pendingInvokes.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify(payload));
    });
  }

  function getLease(tabId: number): LeaseState | null {
    const lease = leaseByTab.get(tabId);
    if (!lease) return null;
    if (lease.expiresAt <= Date.now()) {
      leaseByTab.delete(tabId);
      return null;
    }
    return lease;
  }

  function leaseStatus(tabId: number): JsonRecord {
    const lease = getLease(tabId);
    if (!lease) return { tabId, locked: false };
    return {
      tabId,
      locked: true,
      owner: lease.owner,
      leaseId: lease.leaseId,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      heartbeatAt: new Date(lease.heartbeatAt).toISOString()
    };
  }

  function acquireLease(tabId: number, rawOwner: unknown, rawTtlMs: unknown): JsonRecord {
    const owner = normalizeOwner(rawOwner);
    const ttlMs = normalizeLeaseTtl(rawTtlMs);
    const current = getLease(tabId);
    if (current && current.owner !== owner) {
      return { ok: false, reason: "locked_by_other", lease: leaseStatus(tabId) };
    }
    const next: LeaseState = {
      tabId,
      owner,
      leaseId: current?.leaseId || randomId("lease"),
      createdAt: current?.createdAt || Date.now(),
      heartbeatAt: Date.now(),
      expiresAt: Date.now() + ttlMs
    };
    leaseByTab.set(tabId, next);
    return { ok: true, lease: leaseStatus(tabId) };
  }

  function heartbeatLease(tabId: number, rawOwner: unknown, rawTtlMs: unknown): JsonRecord {
    const owner = normalizeOwner(rawOwner);
    const ttlMs = normalizeLeaseTtl(rawTtlMs);
    const lease = getLease(tabId);
    if (!lease) return { ok: false, reason: "not_locked" };
    if (lease.owner !== owner) return { ok: false, reason: "locked_by_other", lease: leaseStatus(tabId) };
    lease.heartbeatAt = Date.now();
    lease.expiresAt = Date.now() + ttlMs;
    leaseByTab.set(tabId, lease);
    return { ok: true, lease: leaseStatus(tabId) };
  }

  function releaseLease(tabId: number, rawOwner: unknown): JsonRecord {
    const owner = normalizeOwner(rawOwner);
    const lease = getLease(tabId);
    if (!lease) return { ok: true, released: false, reason: "not_locked" };
    if (lease.owner !== owner) return { ok: false, reason: "locked_by_other", lease: leaseStatus(tabId) };
    leaseByTab.delete(tabId);
    return { ok: true, released: true };
  }

  function ensureLeaseForWrite(tabId: number, rawOwner: unknown): void {
    const owner = normalizeOwner(rawOwner);
    const lease = getLease(tabId);
    if (!lease) throw new Error("tab is not leased");
    if (lease.owner !== owner) throw new Error(`tab leased by ${lease.owner}`);
  }

  function getTabTelemetry(tabId: number): TelemetryState {
    if (!telemetryByTab.has(tabId)) {
      telemetryByTab.set(tabId, { console: [], network: [] });
    }
    return telemetryByTab.get(tabId)!;
  }

  function trimTelemetry(items: JsonRecord[], max = 120): void {
    if (items.length > max) {
      items.splice(0, items.length - max);
    }
  }

  function getSnapshotState(tabId: number): SnapshotState {
    const state = snapshotStateByTab.get(tabId);
    if (state) return state;
    const created: SnapshotState = {
      byKey: new Map(),
      refMap: new Map(),
      lastSnapshotId: null
    };
    snapshotStateByTab.set(tabId, created);
    return created;
  }

  function clearSnapshotState(tabId: number): void {
    snapshotStateByTab.delete(tabId);
  }

  function installDebuggerHooks(): void {
    if (debuggerHooksInstalled) return;
    debuggerHooksInstalled = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (!source || typeof source.tabId !== "number") return;
      const tabId = source.tabId;
      const telemetry = getTabTelemetry(tabId);

      if (method === "Runtime.consoleAPICalled") {
        const args = Array.isArray((params as JsonRecord)?.args) ? ((params as JsonRecord).args as JsonRecord[]) : [];
        telemetry.console.push({
          ts: nowIso(),
          type: String((params as JsonRecord)?.type || ""),
          args: args.map((item) => item.value ?? item.description ?? "")
        });
        trimTelemetry(telemetry.console);
        return;
      }

      if (method === "Network.responseReceived") {
        const response = asRecord((params as JsonRecord).response);
        telemetry.network.push({
          ts: nowIso(),
          requestId: (params as JsonRecord).requestId,
          url: response.url,
          status: response.status,
          mimeType: response.mimeType
        });
        trimTelemetry(telemetry.network);
      }
    });

    chrome.debugger.onDetach.addListener((source) => {
      if (!source || typeof source.tabId !== "number") return;
      attachedTabs.delete(source.tabId);
      telemetryByTab.delete(source.tabId);
      clearSnapshotState(source.tabId);
      leaseByTab.delete(source.tabId);
    });
  }

  async function ensureDebugger(tabId: number): Promise<void> {
    installDebuggerHooks();
    if (attachedTabs.has(tabId)) return;
    const target = { tabId };
    await chrome.debugger.attach(target, "1.3");
    attachedTabs.add(tabId);
    await chrome.debugger.sendCommand(target, "Network.enable");
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "DOM.enable");
    await chrome.debugger.sendCommand(target, "Page.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
  }

  async function observeByCDP(tabId: number): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const target = { tabId };
    const evalResult = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        textLength: document.body?.innerText?.length ?? 0,
        nodeCount: document.querySelectorAll('*').length
      }))()`,
      returnByValue: true
    })) as JsonRecord;
    const page = asRecord(asRecord(evalResult.result).value);
    const telemetry = getTabTelemetry(tabId);
    return {
      ts: nowIso(),
      tabId,
      page,
      console: telemetry.console.slice(-20),
      network: telemetry.network.slice(-20)
    };
  }

  async function takeSnapshot(tabId: number, rawOptions: JsonRecord = {}): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const options = normalizeSnapshotOptions(rawOptions);
    const key = snapshotKey(options);
    const state = getSnapshotState(tabId);
    const previous = state.byKey.get(key) || null;
    const target = { tabId };

    if (options.noAnimations === true) {
      await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          const id = "__brain_loop_disable_anim__";
          if (!document.getElementById(id)) {
            const style = document.createElement("style");
            style.id = id;
            style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}";
            document.documentElement.appendChild(style);
          }
          return true;
        })()`,
        returnByValue: true,
        awaitPromise: true
      });
    }

    const snapshotId = randomId("snap");
    const base: JsonRecord = {
      snapshotId,
      ts: nowIso(),
      tabId,
      mode: options.mode,
      filter: options.filter,
      selector: options.selector,
      depth: options.depth,
      maxTokens: options.maxTokens,
      url: "",
      title: "",
      format: options.format
    };

    let snapshot: JsonRecord;
    if (options.mode === "text") {
      const textChars = Math.max(Number(options.maxChars || 4000), Math.min(48_000, Number(options.maxTokens || 1200) * 4));
      const evalResult = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          const selector = ${JSON.stringify(String(options.selector || ""))};
          const scope = selector ? document.querySelector(selector) : document.body;
          if (!scope) return { ok: false, error: "selector not found" };
          const text = String(scope.innerText || "");
          const clipped = text.length > ${textChars} ? text.slice(0, ${textChars}) + "…" : text;
          return { ok: true, text: clipped, textLength: text.length, url: location.href, title: document.title };
        })()`,
        returnByValue: true,
        awaitPromise: true
      })) as JsonRecord;
      const textEvalException = asRecord(evalResult.exceptionDetails);
      if (Object.keys(textEvalException).length > 0) {
        const exceptionObj = asRecord(textEvalException.exception);
        throw new Error(
          `cdp.snapshot text eval exception: ${String(
            textEvalException.text || exceptionObj.description || exceptionObj.value || "unknown"
          )}`
        );
      }
      const value = asRecord(asRecord(evalResult.result).value);
      if (value.ok !== true) {
        throw new Error(`cdp.snapshot failed: ${String(value.error || "text evaluate failed")}`);
      }
      const text = String(value.text || "");
      snapshot = {
        ...base,
        url: String(value.url || ""),
        title: String(value.title || ""),
        text,
        textLength: Number(value.textLength || text.length),
        hash: hashText(text),
        truncated: Number(value.textLength || text.length) > text.length
      };
    } else {
      const evalResult = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          const selector = ${JSON.stringify(String(options.selector || ""))};
          const filter = ${JSON.stringify(String(options.filter || "interactive"))};
          const maxNodes = ${Number(options.maxNodes || 120)};
          const scope = selector ? document.querySelector(selector) : document;
          if (!scope) return { ok: false, error: "selector not found" };
          const interactive = "a,button,input,textarea,select,[role='button'],[role='link'],[role='textbox'],[contenteditable='true'],[tabindex]";
          const all = Array.from((scope === document ? document : scope).querySelectorAll("*"));
          const list = filter === "all" ? all : all.filter((el) => el.matches(interactive));
          const safeAttr = (v) => String(v || "").split("\\\\").join("\\\\\\\\").replace(/"/g, '\\"');
          const isValidIdent = (v) => /^[A-Za-z_][A-Za-z0-9_:\\-\\.]*$/.test(v || "");
          const fallbackPath = (el) => {
            const parts = [];
            let cur = el;
            let depth = 0;
            while (cur && cur.nodeType === 1 && depth < 5) {
              const tag = (cur.tagName || "div").toLowerCase();
              if (cur.id && isValidIdent(cur.id)) {
                parts.unshift("#" + cur.id);
                break;
              }
              let part = tag;
              const cls = String(cur.className || "")
                .split(/\\s+/)
                .map((x) => x.trim())
                .filter(Boolean)
                .find((x) => isValidIdent(x));
              if (cls) part += "." + cls;
              const parent = cur.parentElement;
              if (parent) {
                const sameTag = Array.from(parent.children).filter((child) => child.tagName === cur.tagName);
                if (sameTag.length > 1) {
                  part += ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")";
                }
              }
              parts.unshift(part);
              cur = cur.parentElement;
              depth += 1;
            }
            return parts.join(" > ");
          };
          const makeSelector = (el) => {
            if (el.id && isValidIdent(el.id)) return "#" + el.id;
            const name = (el.getAttribute("name") || "").trim();
            if (name) return el.tagName.toLowerCase() + '[name="' + safeAttr(name) + '"]';
            const testId = (el.getAttribute("data-testid") || el.getAttribute("data-test") || "").trim();
            if (testId) return el.tagName.toLowerCase() + '[data-testid="' + safeAttr(testId) + '"]';
            const ariaLabel = (el.getAttribute("aria-label") || "").trim();
            if (ariaLabel) return el.tagName.toLowerCase() + '[aria-label="' + safeAttr(ariaLabel) + '"]';
            const placeholder = (el.getAttribute("placeholder") || "").trim();
            if (placeholder) return el.tagName.toLowerCase() + '[placeholder="' + safeAttr(placeholder) + '"]';
            return fallbackPath(el);
          };
          const nodes = list.slice(0, maxNodes).map((el) => {
            const role = (el.getAttribute("role") || el.tagName || "node").toLowerCase();
            const text = String(el.textContent || "").replace(/\\s+/g, " ").trim();
            const value = "value" in el ? String(el.value || "") : "";
            const placeholder = String(el.getAttribute("placeholder") || "");
            const ariaLabel = String(el.getAttribute("aria-label") || "");
            return {
              role,
              name: text.slice(0, 180),
              value: value.slice(0, 180),
              placeholder: placeholder.slice(0, 180),
              ariaLabel: ariaLabel.slice(0, 180),
              selector: makeSelector(el),
              disabled: !!el.disabled,
              focused: document.activeElement === el,
              tag: el.tagName.toLowerCase()
            };
          });
          return {
            ok: true,
            url: location.href,
            title: document.title,
            nodes
          };
        })()`,
        returnByValue: true,
        awaitPromise: true
      })) as JsonRecord;
      const interactiveEvalException = asRecord(evalResult.exceptionDetails);
      if (Object.keys(interactiveEvalException).length > 0) {
        const exceptionObj = asRecord(interactiveEvalException.exception);
        throw new Error(
          `cdp.snapshot interactive eval exception: ${String(
            interactiveEvalException.text || exceptionObj.description || exceptionObj.value || "unknown"
          )}`
        );
      }
      const value = asRecord(asRecord(evalResult.result).value);
      if (value.ok !== true) {
        throw new Error(`cdp.snapshot failed: ${String(value.error || "interactive evaluate failed")}`);
      }
      const rawNodes = Array.isArray(value.nodes) ? (value.nodes as JsonRecord[]) : [];
      state.refMap = new Map();
      const nodes = rawNodes.map((node, index) => {
        const ref = `e${index}`;
        const enriched: JsonRecord = {
          ...node,
          ref,
          key,
          snapshotId,
          nodeId: Number(index + 1),
          backendNodeId: Number(index + 1)
        };
        state.refMap.set(ref, enriched);
        return enriched;
      });
      snapshot = {
        ...base,
        url: String(value.url || ""),
        title: String(value.title || ""),
        count: nodes.length,
        nodes,
        truncated: false,
        hash: hashText(nodes.map((node) => summarizeSnapshotNode(node)).join("\n"))
      };
    }

    state.byKey.set(key, snapshot);
    state.lastSnapshotId = snapshotId;
    const diff = options.diff === true ? { hasPrevious: !!previous } : null;
    return {
      ...snapshot,
      diff,
      compact: buildCompactSnapshot(snapshot),
      stats: {
        key,
        hasPrevious: !!previous
      }
    };
  }

  function resolveRefEntry(tabId: number, ref: string): JsonRecord {
    const state = getSnapshotState(tabId);
    const node = state.refMap.get(ref);
    if (!node) throw new Error(`ref ${ref} not found, take /cdp.snapshot first`);
    return node;
  }

  async function executeRefActionByCDP(tabId: number, rawAction: JsonRecord): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const target = { tabId };
    const kind = normalizeActionKind(rawAction.kind);
    const key = typeof rawAction.key === "string" ? rawAction.key.trim() : typeof rawAction.value === "string" ? rawAction.value.trim() : "";
    const value = String(rawAction.value ?? rawAction.text ?? "");

    if (kind === "navigate") {
      const url = String(rawAction.url || "").trim();
      if (!url) throw new Error("url required for navigate");
      const nav = (await chrome.debugger.sendCommand(target, "Page.navigate", { url })) as JsonRecord;
      return {
        tabId,
        kind,
        result: {
          ok: true,
          navigated: true,
          to: url,
          frameId: nav.frameId || null
        }
      };
    }

    if (kind === "press") {
      if (!key) throw new Error("key required for press");
      const out = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => {
          const k = ${JSON.stringify(key)};
          const t = document.activeElement || document.body;
          t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
          t.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
          return { ok: true, pressed: k, url: location.href, title: document.title };
        })()`,
        returnByValue: true,
        awaitPromise: true
      })) as JsonRecord;
      return {
        tabId,
        kind,
        result: asRecord(asRecord(out.result).value)
      };
    }

    const ref = typeof rawAction.ref === "string" ? rawAction.ref.trim() : "";
    const explicitSelector = typeof rawAction.selector === "string" ? rawAction.selector.trim() : "";
    const fromRef = ref ? resolveRefEntry(tabId, ref) : {};
    const selector = String(explicitSelector || fromRef.selector || "").trim();
    const waitForMsRaw = Number(rawAction.waitForMs);
    const waitForMs = Number.isFinite(waitForMsRaw)
      ? Math.max(0, Math.min(10_000, Math.floor(waitForMsRaw)))
      : kind === "click" || kind === "type" || kind === "fill" || kind === "select"
        ? 1_500
        : 0;

    if (!selector) throw new Error("action target not found by ref/selector");

    const expression = `(async () => {
      const selector = ${JSON.stringify(selector)};
      const kind = ${JSON.stringify(kind)};
      const value = ${JSON.stringify(value)};
      const waitForMs = ${waitForMs};
      const hint = ${JSON.stringify({
        tag: String(fromRef.tag || ""),
        role: String(fromRef.role || ""),
        name: String(fromRef.name || ""),
        placeholder: String(fromRef.placeholder || ""),
        ariaLabel: String(fromRef.ariaLabel || "")
      })};
      const allTypables = () => Array.from(
        document.querySelectorAll("input,textarea,[contenteditable='true'],[role='textbox']")
      );
      const pickByHint = () => {
        const nameNeedle = String(hint.name || "").trim().toLowerCase();
        const placeholderNeedle = String(hint.placeholder || "").trim().toLowerCase();
        const ariaNeedle = String(hint.ariaLabel || "").trim().toLowerCase();
        const tagNeedle = String(hint.tag || "").trim().toLowerCase();
        for (const cand of allTypables()) {
          if (tagNeedle && String(cand.tagName || "").toLowerCase() !== tagNeedle) continue;
          const cText = String(cand.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
          const cPlaceholder = String(cand.getAttribute?.("placeholder") || "").trim().toLowerCase();
          const cAria = String(cand.getAttribute?.("aria-label") || "").trim().toLowerCase();
          if (placeholderNeedle && cPlaceholder && cPlaceholder === placeholderNeedle) return cand;
          if (ariaNeedle && cAria && cAria === ariaNeedle) return cand;
          if (nameNeedle && cText && cText.includes(nameNeedle)) return cand;
        }
        return null;
      };
      const applyTextToElement = (el, text, mode) => {
        if (!el) return { ok: false, error: "element missing" };
        if ("disabled" in el && !!el.disabled) return { ok: false, error: "element is disabled" };
        if ("readOnly" in el && !!el.readOnly) return { ok: false, error: "element is readonly" };
        if ("focus" in el) {
          try { el.focus({ preventScroll: true }); } catch { el.focus(); }
        }
        if ("value" in el) {
          let setter = null;
          try {
            const proto = Object.getPrototypeOf(el);
            setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
              || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
              || null;
          } catch {}
          if (setter) {
            setter.call(el, text);
          } else {
            el.value = text;
          }
          try {
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          } catch {
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          if (mode === "fill") el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, typed: text.length, mode, via: "value-setter", url: location.href, title: document.title };
        }
        if (el.isContentEditable) {
          try {
            if (typeof document.execCommand === "function") {
              document.execCommand("selectAll", false);
              document.execCommand("insertText", false, text);
            } else {
              el.textContent = text;
            }
          } catch {
            el.textContent = text;
          }
          try {
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          } catch {
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          if (mode === "fill") el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, typed: text.length, mode, via: "contenteditable", url: location.href, title: document.title };
        }
        return { ok: false, error: "element is not typable", mode };
      };
      const resolveElement = () => {
        const fromSelector = selector ? document.querySelector(selector) : null;
        if (fromSelector) return fromSelector;
        if (kind === "type" || kind === "fill") return pickByHint();
        return null;
      };
      const waitForElement = async () => {
        const started = Date.now();
        while (true) {
          const found = resolveElement();
          if (found) return found;
          if (Date.now() - started >= waitForMs) return null;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      };
      let el = await waitForElement();
      if (!el) return { ok: false, error: "selector not found", selector };
      el.scrollIntoView?.({ block: "center", inline: "nearest" });
      if (kind === "click") {
        el.click?.();
        return { ok: true, clicked: true, url: location.href, title: document.title };
      }
      if (kind === "type" || kind === "fill") {
        return applyTextToElement(el, value, kind);
      }
      if (kind === "select") {
        if (!("value" in el)) return { ok: false, error: "element is not selectable" };
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selected: value, url: location.href, title: document.title };
      }
      if (kind === "scroll") {
        return { ok: true, scrolled: true, url: location.href, title: document.title };
      }
      return { ok: false, error: "unsupported action kind", kind };
    })()`;

    const out = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    })) as JsonRecord;

    const resultValue = asRecord(asRecord(out.result).value);
    if (resultValue.ok === false) {
      throw new Error(String(resultValue.error || "cdp.action failed"));
    }

    return {
      tabId,
      kind,
      ref: ref || undefined,
      selector,
      result: resultValue
    };
  }

  async function executeByCDP(tabId: number, action: JsonRecord): Promise<unknown> {
    await ensureDebugger(tabId);
    const target = { tabId };

    if (action.type === "runtime.evaluate") {
      return await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: action.expression,
        returnByValue: action.returnByValue !== false
      });
    }
    if (action.type === "navigate") {
      return await chrome.debugger.sendCommand(target, "Page.navigate", { url: action.url });
    }
    if (action.domain && action.method) {
      return await chrome.debugger.sendCommand(target, `${String(action.domain)}.${String(action.method)}`, asRecord(action.params));
    }
    throw new Error("Unsupported CDP action");
  }

  async function verifyByCDP(tabId: number, action: JsonRecord, result: JsonRecord | null): Promise<JsonRecord> {
    const observation = await observeByCDP(tabId);
    const checks: JsonRecord[] = [];
    let verified = true;
    const expect = action.expect && typeof action.expect === "object" ? asRecord(action.expect) : action;

    if (expect.expectUrlContains || expect.urlContains) {
      const expected = String(expect.expectUrlContains || expect.urlContains || "");
      const pass = String(asRecord(observation.page).url || "").includes(expected);
      checks.push({ name: "expectUrlContains", pass, expected });
      if (!pass) verified = false;
    }
    if (expect.expectTitleContains || expect.titleContains) {
      const expected = String(expect.expectTitleContains || expect.titleContains || "");
      const pass = String(asRecord(observation.page).title || "").includes(expected);
      checks.push({ name: "expectTitleContains", pass, expected });
      if (!pass) verified = false;
    }
    if (expect.urlChanged === true) {
      const previousUrl = String(expect.previousUrl || asRecord(result).url || "");
      const currentUrl = String(asRecord(observation.page).url || "");
      const pass = !!previousUrl && previousUrl !== currentUrl;
      checks.push({ name: "urlChanged", pass, previousUrl, currentUrl });
      if (!pass) verified = false;
    }
    if (expect.textIncludes) {
      const out = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: `(() => document.body?.innerText || "")()`,
        returnByValue: true
      })) as JsonRecord;
      const text = String(asRecord(out.result).value || "");
      const expected = String(expect.textIncludes);
      const pass = text.includes(expected);
      checks.push({ name: "textIncludes", pass, expected });
      if (!pass) verified = false;
    }
    if (expect.selectorExists) {
      const selector = String(expect.selectorExists);
      const out = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: `(() => !!document.querySelector(${JSON.stringify(selector)}))()`,
        returnByValue: true
      })) as JsonRecord;
      const pass = asRecord(out.result).value === true;
      checks.push({ name: "selectorExists", pass, expected: selector });
      if (!pass) verified = false;
    }

    if (result && result.ok === false) {
      checks.push({ name: "invokeResult", pass: false, expected: "ok=true" });
      verified = false;
    }

    return {
      ok: verified,
      checks,
      observation
    };
  }

  async function detachCDP(tabId: number): Promise<void> {
    if (!attachedTabs.has(tabId)) return;
    await chrome.debugger.detach({ tabId });
    attachedTabs.delete(tabId);
  }

  return {
    disconnectBridge: resetBridgeSocket,
    async handleMessage(message: unknown): Promise<RuntimeInfraResult | null> {
      const msg = asRecord(message);
      const type = String(msg.type || "");
      if (!type) return null;

      if (type === "config.get") {
        return ok(await getBridgeConfig());
      }
      if (type === "config.save") {
        const payload = asRecord(msg.payload);
        const config = await saveBridgeConfig(payload);
        return ok(config);
      }
      if (type === "bridge.connect") {
        await connectBridge(msg.force !== false);
        return ok({ connected: true, at: nowIso() });
      }
      if (type === "bridge.invoke") {
        return ok(await invokeBridge(msg.payload));
      }
      if (type === "lease.acquire") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("lease.acquire 需要有效 tabId");
        return ok(acquireLease(tabId, resolveOwnerFromMessage(msg), msg.ttlMs));
      }
      if (type === "lease.heartbeat") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("lease.heartbeat 需要有效 tabId");
        return ok(heartbeatLease(tabId, resolveOwnerFromMessage(msg), msg.ttlMs));
      }
      if (type === "lease.release") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("lease.release 需要有效 tabId");
        return ok(releaseLease(tabId, resolveOwnerFromMessage(msg)));
      }
      if (type === "lease.status") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("lease.status 需要有效 tabId");
        return ok(leaseStatus(tabId));
      }
      if (type === "cdp.observe") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.observe 需要有效 tabId");
        return ok(await observeByCDP(tabId));
      }
      if (type === "cdp.snapshot") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.snapshot 需要有效 tabId");
        return ok(await takeSnapshot(tabId, asRecord(msg.options)));
      }
      if (type === "cdp.action") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.action 需要有效 tabId");
        const action = asRecord(msg.action);
        const kind = normalizeActionKind(action.kind);
        if (actionRequiresLease(kind)) {
          ensureLeaseForWrite(tabId, resolveOwnerFromMessage(msg));
        }
        return ok(await executeRefActionByCDP(tabId, action));
      }
      if (type === "cdp.execute") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.execute 需要有效 tabId");
        return ok(await executeByCDP(tabId, asRecord(msg.action)));
      }
      if (type === "cdp.verify") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.verify 需要有效 tabId");
        return ok(await verifyByCDP(tabId, asRecord(msg.action), asRecord(msg.result)));
      }
      if (type === "cdp.detach") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.detach 需要有效 tabId");
        await detachCDP(tabId);
        return ok({ detached: true, tabId });
      }

      return null;
    }
  };
}
