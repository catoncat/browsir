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
const MAX_CUSTOM_SYSTEM_PROMPT_CHARS = 12_000;
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 10_000;
const MAX_CDP_COMMAND_TIMEOUT_MS = 60_000;
const CDP_AUTO_DETACH_MS = 30_000;

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
  abortBridgeInvokesBySession(
    sessionId: string,
    reason?: "stop" | "steer_preempt"
  ): number;
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
  sessionId: string;
}

interface PendingCdpCommand {
  method: string;
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

function buildStableRef(node: JsonRecord, sourcePrefix: string): string {
  const backendNodeId = toPositiveInteger(node.backendNodeId);
  if (backendNodeId) return `bn-${backendNodeId}`;
  const fingerprint = [
    String(node.selector || ""),
    String(node.tag || ""),
    String(node.role || ""),
    String(node.name || ""),
    String(node.placeholder || ""),
    String(node.ariaLabel || "")
  ].join("|");
  const hash = hashText(fingerprint || JSON.stringify(node));
  return `${sourcePrefix}-${hash}`;
}

function enrichSnapshotNodes(
  state: SnapshotState,
  nodes: JsonRecord[],
  key: string,
  snapshotId: string,
  sourcePrefix: string
): JsonRecord[] {
  const nextRefMap = new Map(state.refMap);
  const seen = new Map<string, number>();
  const enrichedNodes = nodes.map((node) => {
    const baseRef = buildStableRef(node, sourcePrefix);
    const nextCount = (seen.get(baseRef) || 0) + 1;
    seen.set(baseRef, nextCount);
    const ref = nextCount > 1 ? `${baseRef}-${nextCount}` : baseRef;
    const enriched: JsonRecord = {
      ...node,
      uid: ref,
      ref,
      key,
      snapshotId
    };
    nextRefMap.set(ref, enriched);
    return enriched;
  });
  state.refMap = nextRefMap;
  return enrichedNodes;
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

function normalizeCustomSystemPrompt(raw: unknown, fallback = ""): string {
  if (raw == null) return String(fallback || "");
  const text = String(raw);
  if (!text.trim()) return "";
  if (text.length <= MAX_CUSTOM_SYSTEM_PROMPT_CHARS) return text;
  return text.slice(0, MAX_CUSTOM_SYSTEM_PROMPT_CHARS);
}

function toOptionalFiniteNumber(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toPositiveInteger(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
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

function toRuntimeError(
  message: string,
  meta: { code?: string; details?: unknown; retryable?: boolean; status?: number } = {}
): Error & { code?: string; details?: unknown; retryable?: boolean; status?: number } {
  const err = new Error(message) as Error & {
    code?: string;
    details?: unknown;
    retryable?: boolean;
    status?: number;
  };
  if (meta.code) err.code = meta.code;
  if (meta.details !== undefined) err.details = meta.details;
  if (typeof meta.retryable === "boolean") err.retryable = meta.retryable;
  if (typeof meta.status === "number") err.status = meta.status;
  return err;
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

function readAxValue(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const rec = asRecord(raw);
  if (typeof rec.value === "string") return rec.value;
  if (typeof rec.value === "number" || typeof rec.value === "boolean") return String(rec.value);
  return "";
}

function readAxBooleanProperty(rawProperties: unknown, key: string): boolean | null {
  if (!Array.isArray(rawProperties)) return null;
  for (const item of rawProperties) {
    const entry = asRecord(item);
    if (String(entry.name || "").toLowerCase() !== key.toLowerCase()) continue;
    const value = asRecord(entry.value).value;
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function isInteractiveRole(roleRaw: unknown): boolean {
  const role = String(roleRaw || "").trim().toLowerCase();
  if (!role) return false;
  return [
    "button",
    "link",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "menuitem",
    "option",
    "slider",
    "tab",
    "searchbox",
    "spinbutton",
    "listbox",
    "treeitem",
    "textarea"
  ].includes(role);
}

function collectFrameIdsFromTree(frameTree: unknown, out: string[] = []): string[] {
  const node = asRecord(frameTree);
  const frame = asRecord(node.frame);
  const frameId = String(frame.id || "").trim();
  if (frameId) out.push(frameId);
  const childFrames = Array.isArray(node.childFrames) ? (node.childFrames as unknown[]) : [];
  for (const child of childFrames) {
    collectFrameIdsFromTree(child, out);
  }
  return out;
}

function actionRequiresLease(kind: string): boolean {
  return ["click", "type", "fill", "press", "scroll", "select", "navigate", "hover"].includes(kind);
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
  const attachLocksByTab = new Map<number, Promise<void>>();
  const enabledDomainsByTab = new Map<number, Set<string>>();
  const pendingCdpByTab = new Map<number, Set<PendingCdpCommand>>();
  const cdpAutoDetachTimers = new Map<number, ReturnType<typeof setTimeout>>();
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

  function abortBridgeInvokesBySession(
    rawSessionId: unknown,
    rawReason: unknown = "stop"
  ): number {
    const sessionId = String(rawSessionId || "").trim();
    if (!sessionId) return 0;
    const reason =
      String(rawReason || "").trim().toLowerCase() === "steer_preempt"
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
            code: interruptedBySteer ? "E_BRIDGE_INTERRUPTED" : "E_BRIDGE_ABORTED",
            details: { sessionId, reason },
            retryable: false
          }
        )
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
      "llmSystemPromptCustom",
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
      llmSystemPromptCustom: normalizeCustomSystemPrompt(data.llmSystemPromptCustom, ""),
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
      llmSystemPromptCustom: normalizeCustomSystemPrompt(source.llmSystemPromptCustom, current.llmSystemPromptCustom || ""),
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
      const pendingSessionId = String(payload.sessionId || "").trim();
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
      pendingInvokes.set(id, { resolve, reject, timeout, sessionId: pendingSessionId });
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

  function clearCdpAutoDetach(tabId: number): void {
    const timer = cdpAutoDetachTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      cdpAutoDetachTimers.delete(tabId);
    }
  }

  function scheduleCdpAutoDetach(tabId: number): void {
    clearCdpAutoDetach(tabId);
    cdpAutoDetachTimers.set(
      tabId,
      setTimeout(() => {
        detachCDP(tabId).catch(() => {
          // best-effort auto cleanup
        });
      }, CDP_AUTO_DETACH_MS)
    );
  }

  function touchCdpSession(tabId: number): void {
    if (!attachedTabs.has(tabId)) return;
    scheduleCdpAutoDetach(tabId);
  }

  function rejectPendingCdpCommands(tabId: number, reason: string): void {
    const pending = pendingCdpByTab.get(tabId);
    if (!pending) return;
    pendingCdpByTab.delete(tabId);
    for (const item of pending) {
      clearTimeout(item.timeout);
      item.reject(
        toRuntimeError(`CDP command '${item.method}' aborted: ${reason}`, {
          code: "E_CDP_ABORTED",
          retryable: true,
          details: { tabId, method: item.method, reason }
        })
      );
    }
  }

  async function sendCdpCommand<T = JsonRecord>(
    tabId: number,
    method: string,
    params: unknown = {},
    rawOptions: { timeoutMs?: unknown } = {}
  ): Promise<T> {
    const timeoutMs = toIntInRange(rawOptions.timeoutMs, DEFAULT_CDP_COMMAND_TIMEOUT_MS, 200, MAX_CDP_COMMAND_TIMEOUT_MS);
    touchCdpSession(tabId);
    return await new Promise<T>((resolve, reject) => {
      const pendingSet = pendingCdpByTab.get(tabId) || new Set<PendingCdpCommand>();
      if (!pendingCdpByTab.has(tabId)) pendingCdpByTab.set(tabId, pendingSet);

      let finished = false;
      const finish = (error: unknown, value?: T): void => {
        if (finished) return;
        finished = true;
        pendingSet.delete(entry);
        clearTimeout(entry.timeout);
        if (pendingSet.size === 0) pendingCdpByTab.delete(tabId);
        if (error) {
          reject(
            error instanceof Error
              ? error
              : toRuntimeError(String(error || `CDP command failed: ${method}`), {
                  code: "E_CDP_COMMAND",
                  retryable: true,
                  details: { tabId, method }
                })
          );
          return;
        }
        resolve(value as T);
      };

      const entry: PendingCdpCommand = {
        method,
        reject: (error: Error) => finish(error),
        timeout: setTimeout(() => {
          finish(
            toRuntimeError(`CDP command '${method}' timed out after ${timeoutMs}ms`, {
              code: "E_CDP_TIMEOUT",
              retryable: true,
              details: { tabId, method, timeoutMs }
            })
          );
        }, timeoutMs)
      };
      pendingSet.add(entry);

      Promise.resolve()
        .then(() => chrome.debugger.sendCommand({ tabId }, method, params as object))
        .then((value) => {
          finish(null, value as T);
        })
        .catch((error) => finish(error));
    });
  }

  async function ensureCdpDomains(tabId: number, domains: string[]): Promise<void> {
    const enabled = enabledDomainsByTab.get(tabId) || new Set<string>();
    if (!enabledDomainsByTab.has(tabId)) enabledDomainsByTab.set(tabId, enabled);
    for (const domain of domains) {
      if (enabled.has(domain)) continue;
      try {
        await sendCdpCommand(tabId, `${domain}.enable`, {});
        enabled.add(domain);
      } catch (error) {
        if (domain === "Accessibility") continue;
        throw error;
      }
    }
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
      const tabId = source.tabId;
      attachedTabs.delete(tabId);
      attachLocksByTab.delete(tabId);
      enabledDomainsByTab.delete(tabId);
      clearCdpAutoDetach(tabId);
      rejectPendingCdpCommands(tabId, "debugger detached");
      telemetryByTab.delete(tabId);
      clearSnapshotState(tabId);
      leaseByTab.delete(tabId);
    });

    if (chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        attachedTabs.delete(tabId);
        attachLocksByTab.delete(tabId);
        enabledDomainsByTab.delete(tabId);
        clearCdpAutoDetach(tabId);
        rejectPendingCdpCommands(tabId, "tab closed");
        telemetryByTab.delete(tabId);
        clearSnapshotState(tabId);
        leaseByTab.delete(tabId);
      });
    }
  }

  async function ensureDebugger(tabId: number): Promise<void> {
    installDebuggerHooks();
    if (attachedTabs.has(tabId)) {
      touchCdpSession(tabId);
      await ensureCdpDomains(tabId, ["Network", "Runtime", "DOM", "Page", "Log", "Accessibility"]);
      return;
    }
    const existing = attachLocksByTab.get(tabId);
    if (existing) {
      await existing;
      touchCdpSession(tabId);
      await ensureCdpDomains(tabId, ["Network", "Runtime", "DOM", "Page", "Log", "Accessibility"]);
      return;
    }

    const attachTask = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedTabs.add(tabId);
        enabledDomainsByTab.delete(tabId);
        touchCdpSession(tabId);
      } catch (error) {
        throw toRuntimeError(`attach debugger failed for tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`, {
          code: "E_CDP_ATTACH",
          retryable: true,
          details: { tabId }
        });
      }
    })();
    attachLocksByTab.set(tabId, attachTask);
    try {
      await attachTask;
    } finally {
      attachLocksByTab.delete(tabId);
    }
    await ensureCdpDomains(tabId, ["Network", "Runtime", "DOM", "Page", "Log", "Accessibility"]);
  }

  async function observeByCDP(tabId: number): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const evalResult = (await sendCdpCommand(tabId, "Runtime.evaluate", {
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

  async function listFrameIdsForSnapshot(tabId: number): Promise<string[]> {
    try {
      const frameTreeResult = (await sendCdpCommand(tabId, "Page.getFrameTree", {}, { timeoutMs: 4_000 })) as JsonRecord;
      const frameIds = collectFrameIdsFromTree(frameTreeResult.frameTree).filter(Boolean);
      return Array.from(new Set(frameIds));
    } catch {
      return [];
    }
  }

  async function resolveElementMetaByBackendNode(
    tabId: number,
    backendNodeId: number,
    scopeSelector: string
  ): Promise<JsonRecord | null> {
    let objectId = "";
    try {
      const resolved = (await sendCdpCommand(tabId, "DOM.resolveNode", { backendNodeId })) as JsonRecord;
      objectId = String(asRecord(resolved.object).objectId || "");
      if (!objectId) return null;
      const expression = `function() {
        if (!this || this.nodeType !== 1) return null;
        const scopeSelector = ${JSON.stringify(scopeSelector)};
        const isValidIdent = (v) => /^[A-Za-z_][A-Za-z0-9_:\\-\\.]*$/.test(v || "");
        const safeAttr = (v) => String(v || "").split("\\\\").join("\\\\\\\\").replace(/"/g, '\\"');
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
        let matchesScope = true;
        if (scopeSelector) {
          try {
            matchesScope = this.matches(scopeSelector) || !!this.closest(scopeSelector);
          } catch {
            matchesScope = false;
          }
        }
        const role =
          String(this.getAttribute("role") || "")
            .trim()
            .toLowerCase() || String(this.tagName || "node").toLowerCase();
        const text = String(this.textContent || "").replace(/\\s+/g, " ").trim();
        const value = "value" in this ? String(this.value || "") : "";
        return {
          ok: true,
          matchesScope,
          tag: String(this.tagName || "").toLowerCase(),
          role,
          name: text.slice(0, 180),
          value: value.slice(0, 180),
          placeholder: String(this.getAttribute("placeholder") || "").slice(0, 180),
          ariaLabel: String(this.getAttribute("aria-label") || "").slice(0, 180),
          selector: makeSelector(this),
          disabled: !!this.disabled,
          focused: document.activeElement === this
        };
      }`;
      const result = (await sendCdpCommand(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: expression,
        returnByValue: true,
        awaitPromise: true
      })) as JsonRecord;
      const value = asRecord(asRecord(result.result).value);
      return value.ok === true ? value : null;
    } catch {
      return null;
    } finally {
      if (objectId) {
        await sendCdpCommand(tabId, "Runtime.releaseObject", { objectId }).catch(() => {
          // ignore stale object release
        });
      }
    }
  }

  async function takeInteractiveSnapshotByAX(
    tabId: number,
    options: JsonRecord,
    base: JsonRecord,
    state: SnapshotState,
    key: string,
    snapshotId: string
  ): Promise<JsonRecord> {
    const pageResult = (await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression: `(() => ({ url: location.href, title: document.title }))()`,
      returnByValue: true
    })) as JsonRecord;
    const page = asRecord(asRecord(pageResult.result).value);

    const frameIds = await listFrameIdsForSnapshot(tabId);
    const treeBuckets: Array<{ frameId: string; nodes: JsonRecord[] }> = [];
    for (const frameId of frameIds) {
      try {
        const tree = (await sendCdpCommand(tabId, "Accessibility.getFullAXTree", { frameId })) as JsonRecord;
        const nodes = Array.isArray(tree.nodes) ? (tree.nodes as JsonRecord[]) : [];
        if (nodes.length > 0) treeBuckets.push({ frameId, nodes });
      } catch {
        // ignore inaccessible frame tree and keep others
      }
    }
    if (treeBuckets.length === 0) {
      const fallbackTree = (await sendCdpCommand(tabId, "Accessibility.getFullAXTree", {})) as JsonRecord;
      const nodes = Array.isArray(fallbackTree.nodes) ? (fallbackTree.nodes as JsonRecord[]) : [];
      if (nodes.length > 0) treeBuckets.push({ frameId: "", nodes });
    }
    if (treeBuckets.length === 0) {
      throw toRuntimeError("Accessibility.getFullAXTree returned empty tree", {
        code: "E_CDP_AXTREE_EMPTY",
        retryable: true,
        details: { tabId, frameIds }
      });
    }

    const maxNodes = Number(options.maxNodes || 120);
    const scopeSelector = String(options.selector || "");
    const mode = String(options.mode || "interactive");
    const filter = String(options.filter || "interactive");
    const allowAll = mode === "full" || filter === "all";

    const candidates: JsonRecord[] = [];
    for (const bucket of treeBuckets) {
      for (const rawNode of bucket.nodes) {
        const node = asRecord(rawNode);
        if (node.ignored === true) continue;
        const backendNodeId = toPositiveInteger(node.backendDOMNodeId);
        if (!backendNodeId) continue;
        const role = readAxValue(node.role).trim().toLowerCase();
        const name = readAxValue(node.name).trim();
        const value = readAxValue(node.value).trim();
        const focusable = readAxBooleanProperty(node.properties, "focusable");
        const focused = readAxBooleanProperty(node.properties, "focused");
        const disabled = readAxBooleanProperty(node.properties, "disabled");
        const interactive = isInteractiveRole(role) || focusable === true;
        if (!allowAll && !interactive) continue;
        candidates.push({
          backendNodeId,
          frameId: bucket.frameId,
          axNodeId: String(node.nodeId || ""),
          role: role || "node",
          name: name.slice(0, 180),
          value: value.slice(0, 180),
          focused: focused === true,
          disabled: disabled === true
        });
        if (candidates.length >= Math.max(maxNodes * 3, 240)) break;
      }
      if (candidates.length >= Math.max(maxNodes * 3, 240)) break;
    }

    const enrichedNodes: JsonRecord[] = [];
    const seenBackendNodeIds = new Set<number>();
    for (const item of candidates) {
      const backendNodeId = toPositiveInteger(item.backendNodeId);
      if (!backendNodeId) continue;
      if (seenBackendNodeIds.has(backendNodeId)) continue;
      const meta = await resolveElementMetaByBackendNode(tabId, backendNodeId, scopeSelector);
      if (!meta) continue;
      if (scopeSelector && meta.matchesScope !== true) continue;
      seenBackendNodeIds.add(backendNodeId);
      enrichedNodes.push({
        ...item,
        ...meta
      });
      if (enrichedNodes.length >= maxNodes) break;
    }

    if (enrichedNodes.length === 0) {
      throw toRuntimeError("AXTree produced no actionable nodes", {
        code: "E_CDP_AXTREE_NO_NODES",
        retryable: true,
        details: {
          tabId,
          scopeSelector,
          candidateCount: candidates.length
        }
      });
    }

    const nodes = enrichSnapshotNodes(state, enrichedNodes, key, snapshotId, "ax");

    return {
      ...base,
      url: String(page.url || ""),
      title: String(page.title || ""),
      count: nodes.length,
      nodes,
      truncated: candidates.length > nodes.length,
      source: "ax",
      hash: hashText(nodes.map((node) => summarizeSnapshotNode(node)).join("\n"))
    };
  }

  async function takeInteractiveSnapshotByDomEvaluate(
    tabId: number,
    options: JsonRecord,
    base: JsonRecord,
    state: SnapshotState,
    key: string,
    snapshotId: string
  ): Promise<JsonRecord> {
    const evalResult = (await sendCdpCommand(tabId, "Runtime.evaluate", {
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
    const nodes = enrichSnapshotNodes(state, rawNodes, key, snapshotId, "dom");
    return {
      ...base,
      url: String(value.url || ""),
      title: String(value.title || ""),
      count: nodes.length,
      nodes,
      truncated: false,
      source: "dom",
      hash: hashText(nodes.map((node) => summarizeSnapshotNode(node)).join("\n"))
    };
  }

  async function takeSnapshot(tabId: number, rawOptions: JsonRecord = {}): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const options = normalizeSnapshotOptions(rawOptions);
    const key = snapshotKey(options);
    const state = getSnapshotState(tabId);
    const previous = state.byKey.get(key) || null;

    if (options.noAnimations === true) {
      await sendCdpCommand(tabId, "Runtime.evaluate", {
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
      const evalResult = (await sendCdpCommand(tabId, "Runtime.evaluate", {
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
      try {
        snapshot = await takeInteractiveSnapshotByAX(tabId, options, base, state, key, snapshotId);
      } catch (error) {
        const fallback = await takeInteractiveSnapshotByDomEvaluate(tabId, options, base, state, key, snapshotId);
        snapshot = {
          ...fallback,
          source: "dom-fallback",
          axError: error instanceof Error ? error.message : String(error)
        };
      }
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
    if (node) return node;

    const legacyMatch = /^e(\d+)$/i.exec(ref);
    if (legacyMatch) {
      const index = Number(legacyMatch[1]);
      if (Number.isInteger(index) && index >= 0) {
        const snapshots = Array.from(state.byKey.values());
        if (state.lastSnapshotId) {
          const exact = snapshots.find((snapshot) => String(snapshot.snapshotId || "") === state.lastSnapshotId);
          if (exact) {
            const nodes = Array.isArray(exact.nodes) ? (exact.nodes as JsonRecord[]) : [];
            const picked = nodes[index];
            if (picked && typeof picked === "object") return picked;
          }
        }
        for (let i = snapshots.length - 1; i >= 0; i -= 1) {
          const snapshot = snapshots[i];
          const nodes = Array.isArray(snapshot.nodes) ? (snapshot.nodes as JsonRecord[]) : [];
          const picked = nodes[index];
          if (picked && typeof picked === "object") return picked;
        }
      }
    }

    const backendRefMatch = /^bn-(\d+)$/i.exec(ref);
    if (backendRefMatch) {
      const backendNodeId = Number(backendRefMatch[1]);
      if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
        return {
          uid: ref,
          ref,
          backendNodeId
        };
      }
    }

    throw new Error(`ref ${ref} not found, take /cdp.snapshot first`);
  }

  async function executeActionByBackendNode(
    tabId: number,
    input: {
      backendNodeId: number;
      kind: string;
      value: string;
      waitForMs: number;
    }
  ): Promise<JsonRecord> {
    const kind = input.kind;
    const waitForMs = Math.max(0, Math.min(10_000, Number(input.waitForMs || 0)));
    const started = Date.now();
    let objectId = "";

    const resolveObject = async (): Promise<string> => {
      const resolved = (await sendCdpCommand(tabId, "DOM.resolveNode", {
        backendNodeId: input.backendNodeId
      })) as JsonRecord;
      const nextObjectId = String(asRecord(resolved.object).objectId || "");
      if (!nextObjectId) {
        throw toRuntimeError(`backendNodeId ${input.backendNodeId} resolve failed`, {
          code: "E_CDP_RESOLVE_NODE",
          retryable: true,
          details: { tabId, backendNodeId: input.backendNodeId }
        });
      }
      return nextObjectId;
    };

    while (true) {
      try {
        objectId = await resolveObject();
        break;
      } catch (error) {
        if (Date.now() - started >= waitForMs) throw error;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }

    try {
      const expression = `function() {
        const kind = ${JSON.stringify(kind)};
        const value = ${JSON.stringify(input.value)};
        if (!this || this.nodeType !== 1) return { ok: false, error: "backend node is not element" };
        const el = this;
        const dispatchInputLikeEvents = (target, text, mode) => {
          try {
            target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
          } catch {
            // ignore unsupported InputEvent ctor
          }
          let inputSent = false;
          try {
            target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
            inputSent = true;
          } catch {
            // fallback below
          }
          if (!inputSent) target.dispatchEvent(new Event("input", { bubbles: true }));
          if (mode === "fill") target.dispatchEvent(new Event("change", { bubbles: true }));
          target.dispatchEvent(new Event("keyup", { bubbles: true }));
        };
        const tryMonacoModelSet = (target, text, mode) => {
          try {
            const root =
              target.closest?.(".monaco-editor")
              || (target.classList?.contains?.("monaco-editor") ? target : null);
            if (!root) return null;
            const monaco = globalThis.monaco || window.monaco;
            const editor = monaco?.editor;
            if (!editor) return null;
            const uriRaw = String(
              target.getAttribute?.("data-monaco-uri")
              || root.getAttribute?.("data-monaco-uri")
              || ""
            ).trim();
            let model = null;
            if (uriRaw && monaco?.Uri?.parse && typeof editor.getModel === "function") {
              try {
                model = editor.getModel(monaco.Uri.parse(uriRaw));
              } catch {
                // keep fallback
              }
            }
            if (!model && typeof editor.getModels === "function") {
              const models = editor.getModels();
              if (Array.isArray(models) && models.length > 0) model = models[0];
            }
            if (!model || typeof model.setValue !== "function") return null;
            model.setValue(text);
            if ("value" in target) target.value = text;
            dispatchInputLikeEvents(target, text, mode);
            return { ok: true, typed: text.length, mode, via: "backend-node-monaco", url: location.href, title: document.title };
          } catch {
            return null;
          }
        };
        const applyTextToElement = (target, text, mode) => {
          if ("disabled" in target && !!target.disabled) return { ok: false, error: "element is disabled" };
          if ("readOnly" in target && !!target.readOnly) return { ok: false, error: "element is readonly" };
          if ("focus" in target) {
            try { target.focus({ preventScroll: true }); } catch { target.focus(); }
          }
          const monacoApplied = tryMonacoModelSet(target, text, mode);
          if (monacoApplied) return monacoApplied;
          if ("value" in target) {
            let setter = null;
            try {
              const proto = Object.getPrototypeOf(target);
              setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
                || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
                || null;
            } catch {}
            if (setter) setter.call(target, text);
            else target.value = text;
            dispatchInputLikeEvents(target, text, mode);
            return { ok: true, typed: text.length, mode, via: "backend-node-value", url: location.href, title: document.title };
          }
          if (target.isContentEditable) {
            let usedInsertText = false;
            try {
              // For React/Draft.js-like editors, prefer command-based insertion over raw textContent mutation.
              if (typeof document.execCommand === "function") {
                if (mode === "fill") {
                  try { document.execCommand("selectAll", false); } catch {}
                  try { document.execCommand("delete", false); } catch {}
                }
                usedInsertText = document.execCommand("insertText", false, text) === true;
              }
            } catch {
              usedInsertText = false;
            }
            if (!usedInsertText) {
              target.textContent = text;
            }
            dispatchInputLikeEvents(target, text, mode);
            return {
              ok: true,
              typed: text.length,
              mode,
              via: usedInsertText ? "backend-node-contenteditable-inserttext" : "backend-node-contenteditable-fallback",
              url: location.href,
              title: document.title
            };
          }
          return { ok: false, error: "element is not typable" };
        };
        el.scrollIntoView?.({ block: "center", inline: "nearest" });
        if (kind === "hover") {
          try {
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
          } catch {
            // ignore
          }
          return { ok: true, hovered: true, via: "backend-node", url: location.href, title: document.title };
        }
        if (kind === "click") {
          el.click?.();
          return { ok: true, clicked: true, via: "backend-node", url: location.href, title: document.title };
        }
        if (kind === "type" || kind === "fill") {
          return applyTextToElement(el, value, kind);
        }
        if (kind === "select") {
          if (!("value" in el)) return { ok: false, error: "element is not selectable" };
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, selected: value, via: "backend-node", url: location.href, title: document.title };
        }
        if (kind === "read") {
          if ("value" in el) {
            return { ok: true, value: String(el.value ?? ""), length: String(el.value ?? "").length, via: "backend-node-value", url: location.href, title: document.title };
          }
          if (el.isContentEditable) {
            const text = String(el.textContent || "");
            return { ok: true, value: text, length: text.length, via: "backend-node-contenteditable", url: location.href, title: document.title };
          }
          const text = String(el.textContent || "");
          return { ok: true, value: text, length: text.length, via: "backend-node-text", url: location.href, title: document.title };
        }
        return { ok: false, error: "unsupported backend action", kind };
      }`;
      const out = (await sendCdpCommand(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: expression,
        returnByValue: true,
        awaitPromise: true
      })) as JsonRecord;
      const value = asRecord(asRecord(out.result).value);
      if (value.ok === false) {
        throw toRuntimeError(String(value.error || "backend action failed"), {
          code: "E_CDP_BACKEND_ACTION",
          retryable: true,
          details: { tabId, backendNodeId: input.backendNodeId, kind }
        });
      }
      return value;
    } finally {
      if (objectId) {
        await sendCdpCommand(tabId, "Runtime.releaseObject", { objectId }).catch(() => {
          // ignore stale object release
        });
      }
    }
  }

  async function executeRefActionByCDP(tabId: number, rawAction: JsonRecord): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const kind = normalizeActionKind(rawAction.kind);
    const key = typeof rawAction.key === "string" ? rawAction.key.trim() : typeof rawAction.value === "string" ? rawAction.value.trim() : "";
    const value = String(rawAction.value ?? rawAction.text ?? "");

    if (kind === "navigate") {
      const url = String(rawAction.url || "").trim();
      if (!url) throw new Error("url required for navigate");
      const nav = (await sendCdpCommand(tabId, "Page.navigate", { url })) as JsonRecord;
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
      const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
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

    const refRaw = typeof rawAction.ref === "string" ? rawAction.ref : typeof rawAction.uid === "string" ? rawAction.uid : "";
    const ref = String(refRaw || "").trim();
    const explicitSelector = typeof rawAction.selector === "string" ? rawAction.selector.trim() : "";
    const fromRef = ref ? resolveRefEntry(tabId, ref) : {};
    const selector = String(explicitSelector || fromRef.selector || "").trim();
    const backendNodeId =
      toPositiveInteger(rawAction.backendNodeId) || toPositiveInteger(fromRef.backendNodeId) || toPositiveInteger(fromRef.nodeId);
    const waitForMsRaw = Number(rawAction.waitForMs);
    const waitForMs = Number.isFinite(waitForMsRaw)
      ? Math.max(0, Math.min(10_000, Math.floor(waitForMsRaw)))
      : kind === "click" || kind === "type" || kind === "fill" || kind === "select"
        ? 1_500
        : 0;

    if (backendNodeId && (kind === "click" || kind === "type" || kind === "fill" || kind === "select" || kind === "hover" || kind === "read")) {
      try {
        const backendResult = await executeActionByBackendNode(tabId, {
          backendNodeId,
          kind,
          value,
          waitForMs: selector ? 0 : waitForMs
        });
        return {
          tabId,
          kind,
          uid: ref || undefined,
          ref: ref || undefined,
          selector: selector || undefined,
          backendNodeId,
          result: backendResult
        };
      } catch {
        // fallback to selector flow below
      }
    }

    if (!selector && kind === "scroll") {
      const delta = Number(rawAction.value ?? rawAction.y ?? 0);
      const top = Number.isFinite(delta) ? delta : 0;
      const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const top = Number(${JSON.stringify(top)});
          window.scrollBy({ top: Number.isFinite(top) ? top : 0, left: 0, behavior: "auto" });
          return { ok: true, scrolled: true, top: Number.isFinite(top) ? top : 0, url: location.href, title: document.title };
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

    if (!selector) throw new Error("action target not found by ref/selector/backendNodeId");

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
      ).filter((cand) => {
        if (!cand) return false;
        if ("disabled" in cand && !!cand.disabled) return false;
        if ("readOnly" in cand && !!cand.readOnly) return false;
        const rect = cand.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
      });
      const pickByHint = () => {
        const candidates = allTypables();
        if (candidates.length === 1) return candidates[0];
        const nameNeedle = String(hint.name || "").trim().toLowerCase();
        const placeholderNeedle = String(hint.placeholder || "").trim().toLowerCase();
        const ariaNeedle = String(hint.ariaLabel || "").trim().toLowerCase();
        const tagNeedle = String(hint.tag || "").trim().toLowerCase();
        for (const cand of candidates) {
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
      const dispatchInputLikeEvents = (target, text, mode) => {
        try {
          target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
        } catch {
          // ignore unsupported InputEvent ctor
        }
        let inputSent = false;
        try {
          target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          inputSent = true;
        } catch {
          // fallback below
        }
        if (!inputSent) target.dispatchEvent(new Event("input", { bubbles: true }));
        if (mode === "fill") target.dispatchEvent(new Event("change", { bubbles: true }));
        target.dispatchEvent(new Event("keyup", { bubbles: true }));
      };
      const tryMonacoModelSet = (target, text, mode) => {
        try {
          const root =
            target.closest?.(".monaco-editor")
            || (target.classList?.contains?.("monaco-editor") ? target : null);
          if (!root) return null;
          const monaco = globalThis.monaco || window.monaco;
          const editor = monaco?.editor;
          if (!editor) return null;
          const uriRaw = String(
            target.getAttribute?.("data-monaco-uri")
            || root.getAttribute?.("data-monaco-uri")
            || ""
          ).trim();
          let model = null;
          if (uriRaw && monaco?.Uri?.parse && typeof editor.getModel === "function") {
            try {
              model = editor.getModel(monaco.Uri.parse(uriRaw));
            } catch {
              // keep fallback
            }
          }
          if (!model && typeof editor.getModels === "function") {
            const models = editor.getModels();
            if (Array.isArray(models) && models.length > 0) model = models[0];
          }
          if (!model || typeof model.setValue !== "function") return null;
          model.setValue(text);
          if ("value" in target) target.value = text;
          dispatchInputLikeEvents(target, text, mode);
          return { ok: true, typed: text.length, mode, via: "monaco-model", url: location.href, title: document.title };
        } catch {
          return null;
        }
      };
      const applyTextToElement = (el, text, mode) => {
        if (!el) return { ok: false, error: "element missing" };
        if ("disabled" in el && !!el.disabled) return { ok: false, error: "element is disabled" };
        if ("readOnly" in el && !!el.readOnly) return { ok: false, error: "element is readonly" };
        if ("focus" in el) {
          try { el.focus({ preventScroll: true }); } catch { el.focus(); }
        }
        const monacoApplied = tryMonacoModelSet(el, text, mode);
        if (monacoApplied) return monacoApplied;
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
          dispatchInputLikeEvents(el, text, mode);
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
          dispatchInputLikeEvents(el, text, mode);
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
      if (kind === "hover") {
        try {
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
        } catch {
          // ignore
        }
        return { ok: true, hovered: true, url: location.href, title: document.title };
      }
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
      if (kind === "read") {
        if ("value" in el) {
          const val = String(el.value ?? "");
          return { ok: true, value: val, length: val.length, url: location.href, title: document.title, via: "selector-value" };
        }
        if (el.isContentEditable) {
          const text = String(el.textContent || "");
          return { ok: true, value: text, length: text.length, url: location.href, title: document.title, via: "selector-contenteditable" };
        }
        const text = String(el.textContent || "");
        return { ok: true, value: text, length: text.length, url: location.href, title: document.title, via: "selector-text" };
      }
      if (kind === "scroll") {
        return { ok: true, scrolled: true, url: location.href, title: document.title };
      }
      return { ok: false, error: "unsupported action kind", kind };
    })()`;

    const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
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
      uid: ref || undefined,
      ref: ref || undefined,
      selector,
      backendNodeId: backendNodeId || undefined,
      result: resultValue
    };
  }

  async function executeByCDP(tabId: number, action: JsonRecord): Promise<unknown> {
    await ensureDebugger(tabId);

    if (action.type === "runtime.evaluate") {
      return await sendCdpCommand(tabId, "Runtime.evaluate", {
        expression: action.expression,
        returnByValue: action.returnByValue !== false
      });
    }
    if (action.type === "navigate") {
      return await sendCdpCommand(tabId, "Page.navigate", { url: action.url });
    }
    if (action.domain && action.method) {
      return await sendCdpCommand(tabId, `${String(action.domain)}.${String(action.method)}`, asRecord(action.params));
    }
    throw new Error("Unsupported CDP action");
  }

  async function verifyByCDP(tabId: number, action: JsonRecord, result: JsonRecord | null): Promise<JsonRecord> {
    const expect = action.expect && typeof action.expect === "object" ? asRecord(action.expect) : action;
    const defaultWaitMs =
      expect.urlChanged === true || Boolean(expect.selectorExists) || Boolean(expect.textIncludes) ? 1_500 : 0;
    const waitForMs = toIntInRange(expect.waitForMs, defaultWaitMs, 0, 15_000);
    const pollIntervalMs = toIntInRange(expect.pollIntervalMs, 120, 50, 1_000);
    const started = Date.now();

    let attempts = 0;
    let finalChecks: JsonRecord[] = [];
    let finalObservation: JsonRecord = {};
    let finalVerified = false;

    while (true) {
      attempts += 1;
      const observation = await observeByCDP(tabId);
      const checks: JsonRecord[] = [];
      let verified = true;

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
        const expected = String(expect.textIncludes);
        const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const readText = (doc) => {
              let text = String(doc?.body?.innerText || "");
              const frames = Array.from(doc?.querySelectorAll?.("iframe") || []);
              for (const frame of frames) {
                try {
                  const childDoc = frame.contentDocument;
                  if (!childDoc) continue;
                  text += "\\n" + readText(childDoc);
                } catch {
                  // cross-origin frame
                }
              }
              return text;
            };
            return readText(document);
          })()`,
          returnByValue: true
        })) as JsonRecord;
        const text = String(asRecord(out.result).value || "");
        const pass = text.includes(expected);
        checks.push({ name: "textIncludes", pass, expected });
        if (!pass) verified = false;
      }
      if (expect.selectorExists) {
        const selector = String(expect.selectorExists);
        const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const selector = ${JSON.stringify(selector)};
            const existsIn = (doc) => {
              if (doc?.querySelector?.(selector)) return true;
              const frames = Array.from(doc?.querySelectorAll?.("iframe") || []);
              for (const frame of frames) {
                try {
                  const childDoc = frame.contentDocument;
                  if (!childDoc) continue;
                  if (existsIn(childDoc)) return true;
                } catch {
                  // cross-origin frame
                }
              }
              return false;
            };
            return existsIn(document);
          })()`,
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

      finalChecks = checks;
      finalObservation = observation;
      finalVerified = verified;

      if (verified) break;
      if (Date.now() - started >= waitForMs) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return {
      ok: finalVerified,
      checks: finalChecks,
      observation: finalObservation,
      attempts,
      elapsedMs: Date.now() - started
    };
  }

  async function detachCDP(tabId: number): Promise<void> {
    clearCdpAutoDetach(tabId);
    rejectPendingCdpCommands(tabId, "detach requested");
    if (attachedTabs.has(tabId)) {
      await chrome.debugger.detach({ tabId });
    }
    attachedTabs.delete(tabId);
    attachLocksByTab.delete(tabId);
    enabledDomainsByTab.delete(tabId);
  }

  async function focusTabBeforeAction(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (Number.isInteger(tab?.windowId) && Number(tab.windowId) > 0) {
        await chrome.windows.update(Number(tab.windowId), { focused: true }).catch(() => {});
      }
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    } catch {
      // best-effort focus; do not fail action pipeline on focus hint failure
    }
  }

  return {
    disconnectBridge: resetBridgeSocket,
    abortBridgeInvokesBySession,
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
        if (action.requireFocus === true && action.forceFocus !== true) {
          return fail(
            toRuntimeError("action requires focused tab", {
              code: "E_CDP_FOCUS_REQUIRED",
              retryable: true,
              details: { tabId }
            })
          );
        }
        if (action.forceFocus === true) {
          await focusTabBeforeAction(tabId);
        }
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
