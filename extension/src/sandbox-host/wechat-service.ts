import {
  HOST_PROTOCOL_VERSION,
  WECHAT_HOST_STATE_EVENT_TYPE,
  type WechatAuthStatus,
  type WechatHostStateSnapshot,
  type WechatReplySendInput,
  type WechatReplySendResult,
  type WechatTransportStatus,
} from "../sw/kernel/host-protocol";
import {
  DEFAULT_BASE_URL,
  WechatApiError,
  fetchQrCode,
  getUpdates,
  pollQrStatus,
  sendTextMessage,
  type WechatCredentials,
  type WechatGetUpdatesResponse,
  type WechatMessage,
} from "./wechat-api";

const WECHAT_RUNTIME_KEY = "bbl.wechat.runtime.v2";
const WECHAT_STATE_KEY = "bbl.wechat.host.state.v1";
const WECHAT_SEND_LOG_KEY = "bbl.wechat.host.send-log.v1";
const WECHAT_CREDENTIALS_KEY = "bbl.wechat.host.credentials.v1";
const WECHAT_CURSOR_KEY = "bbl.wechat.host.cursor.v1";
const WECHAT_CONTEXT_TOKENS_KEY = "bbl.wechat.host.context-tokens.v1";
const WECHAT_RUNTIME_VERSION = 2;
const QR_POLL_INTERVAL_MS = 2_000;
const CONTEXT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONTEXT_TOKEN_MAX_ENTRIES = 200;
const SEND_LOG_MAX_ENTRIES = 20;
const UPDATE_BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

interface ContextTokenEntry {
  token: string;
  updatedAt: string;
}

interface WechatSendLogEntry {
  deliveryId: string;
  channelTurnId: string;
  sessionId: string;
  parts: Array<{ kind: "text"; text: string; clientId?: string }>;
  sentAt: string;
}

interface WechatRuntimeRecord {
  version: number;
  hostEpoch: string;
  protocolVersion: typeof HOST_PROTOCOL_VERSION;
  enabled: boolean;
  auth: {
    status: WechatAuthStatus;
    updatedAt: string;
    qrCode?: string;
    qrImageUrl?: string;
    baseUrl?: string;
    accountId?: string;
    botUserId?: string;
    lastError?: string;
  };
  transport: {
    status: WechatTransportStatus;
    updatedAt: string;
    resumable: boolean;
    consecutiveFailures: number;
    nextRetryAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
  };
  resume: {
    resumable: boolean;
    lastResumeAt?: string;
    lastResumeReason?: string;
  };
  credentials: WechatCredentials | null;
  cursor: string;
  contextTokens: Record<string, ContextTokenEntry>;
  sendLog: WechatSendLogEntry[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function createInitialRuntimeRecord(): WechatRuntimeRecord {
  const at = nowIso();
  return {
    version: WECHAT_RUNTIME_VERSION,
    hostEpoch: crypto.randomUUID(),
    protocolVersion: HOST_PROTOCOL_VERSION,
    enabled: false,
    auth: {
      status: "logged_out",
      updatedAt: at,
    },
    transport: {
      status: "stopped",
      updatedAt: at,
      resumable: false,
      consecutiveFailures: 0,
    },
    resume: {
      resumable: false,
    },
    credentials: null,
    cursor: "",
    contextTokens: {},
    sendLog: [],
  };
}

function isWechatCredentials(value: unknown): value is WechatCredentials {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.token === "string" &&
    typeof row.baseUrl === "string" &&
    typeof row.accountId === "string" &&
    typeof row.userId === "string"
  );
}

function normalizeAuthStatus(value: unknown): WechatAuthStatus {
  const status = String(value || "").trim();
  if (
    status === "pending_qr" ||
    status === "authenticated" ||
    status === "reauth_required"
  ) {
    return status;
  }
  return "logged_out";
}

function normalizeTransportStatus(value: unknown): WechatTransportStatus {
  const status = String(value || "").trim();
  if (
    status === "starting" ||
    status === "healthy" ||
    status === "backing_off" ||
    status === "degraded"
  ) {
    return status;
  }
  return "stopped";
}

function normalizeContextTokenEntry(value: unknown): ContextTokenEntry | null {
  if (typeof value === "string") {
    const token = value.trim();
    return token ? { token, updatedAt: nowIso() } : null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const token = String(row.token || "").trim();
  const updatedAt = String(row.updatedAt || "").trim() || nowIso();
  return token ? { token, updatedAt } : null;
}

function pruneContextTokens(
  tokens: Record<string, ContextTokenEntry>,
): Record<string, ContextTokenEntry> {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(tokens)
      .map(([userId, value]) => [String(userId), normalizeContextTokenEntry(value)] as const)
      .filter(
        ([userId, value]) =>
          userId &&
          value &&
          Number.isFinite(Date.parse(value.updatedAt)) &&
          now - Date.parse(value.updatedAt) <= CONTEXT_TOKEN_TTL_MS,
      )
      .sort(
        (a, b) => Date.parse(b[1]!.updatedAt) - Date.parse(a[1]!.updatedAt),
      )
      .slice(0, CONTEXT_TOKEN_MAX_ENTRIES)
      .map(([userId, value]) => [userId, value!] as const),
  );
}

function normalizeSendLog(value: unknown): WechatSendLogEntry[] {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => {
      const row = toRecord(item);
      const deliveryId = String(row.deliveryId || "").trim();
      const channelTurnId = String(row.channelTurnId || "").trim();
      const sessionId = String(row.sessionId || "").trim();
      const sentAt = String(row.sentAt || "").trim();
      const parts = Array.isArray(row.parts)
        ? row.parts
          .map((part) => {
            const partRow = toRecord(part);
            const kind = String(partRow.kind || "").trim();
            const text = String(partRow.text || "");
            const clientId = String(partRow.clientId || "").trim();
            if (kind !== "text" || !text) return null;
            return clientId
              ? { kind: "text" as const, text, clientId }
              : { kind: "text" as const, text };
          })
          .filter(Boolean) as Array<{ kind: "text"; text: string; clientId?: string }>
        : [];
      if (!deliveryId || !channelTurnId || !sessionId || !sentAt) return null;
      return { deliveryId, channelTurnId, sessionId, sentAt, parts };
    })
    .filter(Boolean)
    .slice(-SEND_LOG_MAX_ENTRIES) as WechatSendLogEntry[];
}

function deriveResumable(runtime: WechatRuntimeRecord): boolean {
  if (
    runtime.auth.status === "pending_qr" &&
    String(runtime.auth.qrCode || "").trim()
  ) {
    return true;
  }
  return (
    runtime.auth.status === "authenticated" &&
    runtime.credentials !== null
  );
}

function normalizeRuntimeRecord(raw: unknown): WechatRuntimeRecord {
  const initial = createInitialRuntimeRecord();
  const row = toRecord(raw);
  const authRow = toRecord(row.auth);
  const transportRow = toRecord(row.transport);
  const resumeRow = toRecord(row.resume);
  const normalized: WechatRuntimeRecord = {
    version: Number(row.version || WECHAT_RUNTIME_VERSION),
    hostEpoch: String(row.hostEpoch || "").trim() || initial.hostEpoch,
    protocolVersion: HOST_PROTOCOL_VERSION,
    enabled: row.enabled === true,
    auth: {
      status: normalizeAuthStatus(authRow.status),
      updatedAt: String(authRow.updatedAt || "").trim() || initial.auth.updatedAt,
      ...(String(authRow.qrCode || "").trim()
        ? { qrCode: String(authRow.qrCode || "").trim() }
        : {}),
      ...(String(authRow.qrImageUrl || "").trim()
        ? { qrImageUrl: String(authRow.qrImageUrl || "").trim() }
        : {}),
      ...(String(authRow.baseUrl || "").trim()
        ? { baseUrl: String(authRow.baseUrl || "").trim() }
        : {}),
      ...(String(authRow.accountId || "").trim()
        ? { accountId: String(authRow.accountId || "").trim() }
        : {}),
      ...(String(authRow.botUserId || "").trim()
        ? { botUserId: String(authRow.botUserId || "").trim() }
        : {}),
      ...(String(authRow.lastError || "").trim()
        ? { lastError: String(authRow.lastError || "").trim() }
        : {}),
    },
    transport: {
      status: normalizeTransportStatus(transportRow.status),
      updatedAt:
        String(transportRow.updatedAt || "").trim() || initial.transport.updatedAt,
      resumable: transportRow.resumable === true,
      consecutiveFailures: Math.max(
        0,
        Number.isFinite(Number(transportRow.consecutiveFailures))
          ? Math.trunc(Number(transportRow.consecutiveFailures))
          : 0,
      ),
      ...(String(transportRow.nextRetryAt || "").trim()
        ? { nextRetryAt: String(transportRow.nextRetryAt || "").trim() }
        : {}),
      ...(String(transportRow.lastSuccessAt || "").trim()
        ? { lastSuccessAt: String(transportRow.lastSuccessAt || "").trim() }
        : {}),
      ...(String(transportRow.lastError || "").trim()
        ? { lastError: String(transportRow.lastError || "").trim() }
        : {}),
    },
    resume: {
      resumable: resumeRow.resumable === true,
      ...(String(resumeRow.lastResumeAt || "").trim()
        ? { lastResumeAt: String(resumeRow.lastResumeAt || "").trim() }
        : {}),
      ...(String(resumeRow.lastResumeReason || "").trim()
        ? { lastResumeReason: String(resumeRow.lastResumeReason || "").trim() }
        : {}),
    },
    credentials: isWechatCredentials(row.credentials) ? row.credentials : null,
    cursor: String(row.cursor || "").trim(),
    contextTokens: pruneContextTokens(
      toRecord(row.contextTokens) as Record<string, ContextTokenEntry>,
    ),
    sendLog: normalizeSendLog(row.sendLog),
  };
  normalized.transport.resumable = deriveResumable(normalized);
  normalized.resume.resumable = normalized.transport.resumable;
  if (normalized.auth.status === "authenticated" && !normalized.credentials) {
    normalized.auth.status = "reauth_required";
  }
  if (!normalized.enabled) {
    normalized.transport.status = "stopped";
    delete normalized.transport.nextRetryAt;
  }
  return normalized;
}

function buildSnapshot(runtime: WechatRuntimeRecord): WechatHostStateSnapshot {
  return {
    hostEpoch: runtime.hostEpoch,
    protocolVersion: HOST_PROTOCOL_VERSION,
    enabled: runtime.enabled,
    auth: { ...runtime.auth },
    transport: { ...runtime.transport },
    resume: { ...runtime.resume },
  };
}

function readLegacyState(): {
  hostEpoch: string;
  enabled: boolean;
  login: {
    status: "logged_out" | "pending" | "logged_in" | "error";
    updatedAt: string;
    qrCode?: string;
    qrImageUrl?: string;
    baseUrl?: string;
    accountId?: string;
    botUserId?: string;
    lastError?: string;
  };
} | null {
  try {
    const raw = localStorage.getItem(WECHAT_STATE_KEY);
    if (!raw) return null;
    const row = toRecord(JSON.parse(raw));
    const loginRow = toRecord(row.login);
    const status = String(loginRow.status || "").trim();
    return {
      hostEpoch: String(row.hostEpoch || "").trim() || crypto.randomUUID(),
      enabled: row.enabled === true,
      login: {
        status:
          status === "pending" ||
          status === "logged_in" ||
          status === "error"
            ? status
            : "logged_out",
        updatedAt: String(loginRow.updatedAt || "").trim() || nowIso(),
        ...(String(loginRow.qrCode || "").trim()
          ? { qrCode: String(loginRow.qrCode || "").trim() }
          : {}),
        ...(String(loginRow.qrImageUrl || "").trim()
          ? { qrImageUrl: String(loginRow.qrImageUrl || "").trim() }
          : {}),
        ...(String(loginRow.baseUrl || "").trim()
          ? { baseUrl: String(loginRow.baseUrl || "").trim() }
          : {}),
        ...(String(loginRow.accountId || "").trim()
          ? { accountId: String(loginRow.accountId || "").trim() }
          : {}),
        ...(String(loginRow.botUserId || "").trim()
          ? { botUserId: String(loginRow.botUserId || "").trim() }
          : {}),
        ...(String(loginRow.lastError || "").trim()
          ? { lastError: String(loginRow.lastError || "").trim() }
          : {}),
      },
    };
  } catch {
    return null;
  }
}

function readLegacyCredentials(): WechatCredentials | null {
  try {
    const raw = localStorage.getItem(WECHAT_CREDENTIALS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isWechatCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLegacyCursor(): string {
  return String(localStorage.getItem(WECHAT_CURSOR_KEY) || "").trim();
}

function readLegacyContextTokens(): Record<string, ContextTokenEntry> {
  try {
    const raw = localStorage.getItem(WECHAT_CONTEXT_TOKENS_KEY);
    if (!raw) return {};
    return pruneContextTokens(
      toRecord(JSON.parse(raw)) as Record<string, ContextTokenEntry>,
    );
  } catch {
    return {};
  }
}

function readLegacySendLog(): WechatSendLogEntry[] {
  try {
    const raw = localStorage.getItem(WECHAT_SEND_LOG_KEY);
    if (!raw) return [];
    return normalizeSendLog(JSON.parse(raw));
  } catch {
    return [];
  }
}

function clearLegacyStorage(): void {
  localStorage.removeItem(WECHAT_STATE_KEY);
  localStorage.removeItem(WECHAT_SEND_LOG_KEY);
  localStorage.removeItem(WECHAT_CREDENTIALS_KEY);
  localStorage.removeItem(WECHAT_CURSOR_KEY);
  localStorage.removeItem(WECHAT_CONTEXT_TOKENS_KEY);
}

function migrateLegacyRuntime(): WechatRuntimeRecord | null {
  const legacyState = readLegacyState();
  const legacyCredentials = readLegacyCredentials();
  const hasLegacy =
    legacyState !== null ||
    legacyCredentials !== null ||
    !!readLegacyCursor() ||
    Object.keys(readLegacyContextTokens()).length > 0 ||
    readLegacySendLog().length > 0;
  if (!hasLegacy) return null;

  const runtime = createInitialRuntimeRecord();
  runtime.enabled = legacyState?.enabled === true;
  runtime.credentials = legacyCredentials;
  runtime.cursor = readLegacyCursor();
  runtime.contextTokens = readLegacyContextTokens();
  runtime.sendLog = readLegacySendLog();

  if (legacyState) {
    runtime.auth.updatedAt = legacyState.login.updatedAt;
    runtime.auth.baseUrl = legacyState.login.baseUrl;
    runtime.auth.accountId = legacyState.login.accountId;
    runtime.auth.botUserId = legacyState.login.botUserId;
    runtime.auth.lastError = legacyState.login.lastError;
    runtime.auth.qrCode = legacyState.login.qrCode;
    runtime.auth.qrImageUrl = legacyState.login.qrImageUrl;
    if (legacyState.login.status === "pending" && legacyState.login.qrCode) {
      runtime.auth.status = "pending_qr";
    } else if (legacyCredentials) {
      runtime.auth.status = "authenticated";
    } else if (legacyState.login.status === "error") {
      runtime.auth.status = "reauth_required";
    }
  } else if (legacyCredentials) {
    runtime.auth.status = "authenticated";
    runtime.auth.baseUrl = legacyCredentials.baseUrl;
    runtime.auth.accountId = legacyCredentials.accountId;
    runtime.auth.botUserId = legacyCredentials.userId;
  }

  runtime.transport.status =
    runtime.enabled && runtime.auth.status === "authenticated"
      ? "degraded"
      : "stopped";
  runtime.transport.updatedAt = nowIso();
  runtime.transport.resumable = deriveResumable(runtime);
  runtime.resume.resumable = runtime.transport.resumable;
  return runtime;
}

function getBackoffDelayMs(failureCount: number): number {
  const index = Math.max(
    0,
    Math.min(failureCount - 1, UPDATE_BACKOFF_STEPS_MS.length - 1),
  );
  return UPDATE_BACKOFF_STEPS_MS[index] || UPDATE_BACKOFF_STEPS_MS[UPDATE_BACKOFF_STEPS_MS.length - 1];
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  const row = error as { name?: string; message?: string };
  const name = String(row.name || "").trim();
  const message = String(row.message || "").trim().toLowerCase();
  return (
    name === "AbortError" ||
    message === "the operation was aborted." ||
    message === "the operation was aborted" ||
    message.includes("signal is aborted") ||
    message.includes("aborterror")
  );
}

function isTimeoutLikeError(error: unknown): boolean {
  if (!error) return false;
  const row = error as { name?: string; message?: string };
  const name = String(row.name || "").trim().toLowerCase();
  const message = String(row.message || "").trim().toLowerCase();
  return (
    name === "timeouterror" ||
    message.includes("signal timed out") ||
    message.includes("timed out")
  );
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof WechatApiError) {
    return error.code === -14 || error.status === 401;
  }
  const row = error as { code?: unknown; status?: unknown; message?: unknown };
  return Number(row.code) === -14 || Number(row.status) === 401;
}

function collectBotIds(credentials: WechatCredentials): Set<string> {
  return new Set(
    [credentials.accountId, credentials.userId]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
}

function resolvePeerUserIdForContext(
  credentials: WechatCredentials,
  message: WechatMessage,
): string | null {
  const botIds = collectBotIds(credentials);
  const fromUserId = String(message.from_user_id || "").trim();
  const toUserId = String(message.to_user_id || "").trim();
  const accountId = String(credentials.accountId || "").trim();
  const actorUserId = String(credentials.userId || "").trim();

  if (toUserId && accountId && toUserId === accountId) {
    return fromUserId || null;
  }
  if (
    toUserId &&
    actorUserId &&
    toUserId === actorUserId &&
    fromUserId &&
    !botIds.has(fromUserId)
  ) {
    return fromUserId;
  }
  if (fromUserId && botIds.has(fromUserId) && toUserId && !botIds.has(toUserId)) {
    return toUserId;
  }
  if (fromUserId && !botIds.has(fromUserId)) return fromUserId;
  if (toUserId && !botIds.has(toUserId)) return toUserId;
  return null;
}

function isInboundMessage(
  credentials: WechatCredentials,
  message: WechatMessage,
): boolean {
  const botIds = collectBotIds(credentials);
  const fromUserId = String(message.from_user_id || "").trim();
  const toUserId = String(message.to_user_id || "").trim();
  const accountId = String(credentials.accountId || "").trim();
  const actorUserId = String(credentials.userId || "").trim();

  if (!fromUserId || !toUserId) return false;
  if (accountId && toUserId === accountId) {
    return fromUserId !== accountId;
  }
  if (actorUserId && toUserId === actorUserId) {
    return !botIds.has(fromUserId);
  }
  return false;
}

export class WechatHostService {
  private loginPollTimer: ReturnType<typeof setTimeout> | null = null;
  private updatePollTimer: ReturnType<typeof setTimeout> | null = null;
  private updatePollController: AbortController | null = null;
  private updatePollDueAt: number | null = null;
  private runtime: WechatRuntimeRecord = createInitialRuntimeRecord();
  private readonly readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    const stored = await chrome.storage.local.get(WECHAT_RUNTIME_KEY);
    const persisted = stored[WECHAT_RUNTIME_KEY];
    const migrated = persisted ? null : migrateLegacyRuntime();
    this.runtime = normalizeRuntimeRecord(persisted || migrated || createInitialRuntimeRecord());
    this.runtime.hostEpoch = crypto.randomUUID();
    this.runtime.protocolVersion = HOST_PROTOCOL_VERSION;
    this.runtime.transport.resumable = deriveResumable(this.runtime);
    this.runtime.resume.resumable = this.runtime.transport.resumable;
    if (this.runtime.enabled && this.runtime.auth.status === "authenticated") {
      this.runtime.transport.status = "degraded";
      this.runtime.transport.updatedAt = nowIso();
    }
    await this.persistRuntime({ emit: false });
    if (migrated) {
      clearLegacyStorage();
    }
  }

  private async ensureReady(): Promise<void> {
    await this.readyPromise;
  }

  private emitHostState(): void {
    const snapshot = buildSnapshot(this.runtime);
    queueMicrotask(() => {
      void globalThis.chrome?.runtime?.sendMessage?.({
        type: WECHAT_HOST_STATE_EVENT_TYPE,
        payload: snapshot,
      })?.catch(() => {});
    });
  }

  private async persistRuntime(
    options: { emit?: boolean } = {},
  ): Promise<WechatHostStateSnapshot> {
    this.runtime.transport.resumable = deriveResumable(this.runtime);
    this.runtime.resume.resumable = this.runtime.transport.resumable;
    await chrome.storage.local.set({
      [WECHAT_RUNTIME_KEY]: this.runtime,
    });
    if (options.emit !== false) {
      this.emitHostState();
    }
    return buildSnapshot(this.runtime);
  }

  private clearLoginPoll(): void {
    if (!this.loginPollTimer) return;
    clearTimeout(this.loginPollTimer);
    this.loginPollTimer = null;
  }

  private clearUpdatePoll(options: { abortInFlight?: boolean } = {}): void {
    const abortInFlight = options.abortInFlight !== false;
    if (this.updatePollTimer) {
      clearTimeout(this.updatePollTimer);
      this.updatePollTimer = null;
    }
    this.updatePollDueAt = null;
    if (abortInFlight) {
      this.updatePollController?.abort();
      this.updatePollController = null;
    }
  }

  private scheduleLoginPoll(qrCode: string): void {
    this.clearLoginPoll();
    this.loginPollTimer = setTimeout(() => {
      void this.pollLogin(qrCode);
    }, QR_POLL_INTERVAL_MS);
  }

  private scheduleUpdatePoll(delayMs = 0): void {
    if (this.updatePollController) return;
    const safeDelayMs = Math.max(0, Math.floor(delayMs));
    const dueAt = Date.now() + safeDelayMs;
    if (
      this.updatePollTimer &&
      this.updatePollDueAt !== null &&
      this.updatePollDueAt <= dueAt
    ) {
      return;
    }
    if (this.updatePollTimer) {
      clearTimeout(this.updatePollTimer);
    }
    this.updatePollDueAt = dueAt;
    this.updatePollTimer = setTimeout(() => {
      this.updatePollTimer = null;
      this.updatePollDueAt = null;
      void this.pollUpdates();
    }, Math.max(0, dueAt - Date.now()));
  }

  private ensureUpdatePoll(): void {
    if (this.updatePollTimer || this.updatePollController) return;
    this.scheduleUpdatePoll(0);
  }

  private rememberContext(
    credentials: WechatCredentials,
    message: WechatMessage,
  ): boolean {
    const userId = resolvePeerUserIdForContext(credentials, message);
    if (!userId || !message.context_token) return false;
    const current = this.runtime.contextTokens[userId];
    const next: ContextTokenEntry = {
      token: message.context_token,
      updatedAt: nowIso(),
    };
    if (
      current?.token === next.token &&
      current?.updatedAt === next.updatedAt
    ) {
      return false;
    }
    this.runtime.contextTokens = pruneContextTokens({
      ...this.runtime.contextTokens,
      [userId]: next,
    });
    return true;
  }

  private toInboundMessage(
    credentials: WechatCredentials,
    message: WechatMessage,
  ): Record<string, unknown> | null {
    if (message.message_type !== 1) {
      console.debug("[wechat] toInbound: skip non-text message", message.message_type);
      return null;
    }
    const remoteUserId = resolvePeerUserIdForContext(credentials, message);
    const botIds = collectBotIds(credentials);
    if (!remoteUserId) {
      console.warn("[wechat] toInbound: no remoteUserId resolved", {
        from: message.from_user_id,
        to: message.to_user_id,
        botIds: [...botIds],
      });
      return null;
    }
    if (!isInboundMessage(credentials, message)) {
      console.warn("[wechat] toInbound: message not inbound, skip", {
        from_user_id: message.from_user_id,
        to_user_id: message.to_user_id,
        botIds: [...botIds],
      });
      return null;
    }
    const text = message.item_list
      ?.filter((item) => Number(item.type) === 1)
      .map((item) => String(item.text_item?.text || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) return null;
    return {
      type: "brain.channel.wechat.inbound",
      remoteConversationId: remoteUserId,
      remoteUserId,
      remoteMessageId: String(message.message_id || "").trim(),
      text,
      contextToken: message.context_token,
      receivedAt: new Date(message.create_time_ms).toISOString(),
    };
  }

  private async deliverInboundBatch(
    credentials: WechatCredentials,
    updates: WechatGetUpdatesResponse,
  ): Promise<void> {
    let changed = false;
    for (const message of updates.msgs || []) {
      changed = this.rememberContext(credentials, message) || changed;
      const inbound = this.toInboundMessage(credentials, message);
      if (!inbound) {
        console.warn("[wechat] inbound dropped", {
          messageId: message.message_id,
          messageType: message.message_type,
          fromUserId: message.from_user_id,
          toUserId: message.to_user_id,
          botUserIds: [...collectBotIds(credentials)],
          hasText: Boolean(
            message.item_list
              ?.filter((item) => Number(item.type) === 1)
              .some((item) => String(item.text_item?.text || "").trim()),
          ),
          resolvePeerResult: resolvePeerUserIdForContext(credentials, message),
        });
        continue;
      }
      const response = (await chrome.runtime.sendMessage(inbound)) as
        | { ok?: boolean; data?: Record<string, unknown>; error?: string }
        | undefined;
      if (!response?.ok) {
        throw new Error(response?.error || "Inbound handoff failed");
      }
      const status = String((response.data as Record<string, unknown>)?.status || "");
      if (status !== "accepted" && status !== "duplicate") {
        throw new Error(`Unexpected inbound status: ${status || "unknown"}`);
      }
    }
    if (updates.get_updates_buf) {
      this.runtime.cursor = String(updates.get_updates_buf || "").trim();
      changed = true;
    }
    if (changed) {
      await this.persistRuntime({ emit: false });
    }
  }

  private markTransportStopped(): void {
    this.runtime.transport = {
      ...this.runtime.transport,
      status: "stopped",
      updatedAt: nowIso(),
      nextRetryAt: undefined,
    };
  }

  private async markReauthRequired(message: string): Promise<void> {
    this.clearUpdatePoll();
    this.runtime.credentials = null;
    this.runtime.cursor = "";
    this.runtime.contextTokens = {};
    this.runtime.auth = {
      status: "reauth_required",
      updatedAt: nowIso(),
      baseUrl: this.runtime.auth.baseUrl,
      accountId: this.runtime.auth.accountId,
      botUserId: this.runtime.auth.botUserId,
      lastError: message,
    };
    this.runtime.transport = {
      ...this.runtime.transport,
      status: "stopped",
      updatedAt: nowIso(),
      resumable: false,
      nextRetryAt: undefined,
      lastError: message,
    };
    await this.persistRuntime();
  }

  private async markTransportBackoff(error: unknown): Promise<void> {
    const consecutiveFailures = this.runtime.transport.consecutiveFailures + 1;
    const delayMs = getBackoffDelayMs(consecutiveFailures);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    this.runtime.transport = {
      ...this.runtime.transport,
      status: "backing_off",
      updatedAt: nowIso(),
      resumable: true,
      consecutiveFailures,
      nextRetryAt,
      lastError: error instanceof Error ? error.message : String(error),
    };
    await this.persistRuntime();
    if (this.runtime.enabled && this.runtime.auth.status === "authenticated") {
      this.scheduleUpdatePoll(delayMs);
    }
  }

  private async pollUpdates(): Promise<void> {
    await this.ensureReady();
    const credentials = this.runtime.credentials;
    if (!credentials) {
      console.warn("[wechat] pollUpdates: no credentials, skip");
      this.markTransportStopped();
      await this.persistRuntime();
      return;
    }
    if (!this.runtime.enabled || this.runtime.auth.status !== "authenticated") {
      this.markTransportStopped();
      await this.persistRuntime();
      return;
    }

    let nextPollDelayMs: number | null = null;
    const controller = new AbortController();
    this.updatePollController = controller;
    this.runtime.transport = {
      ...this.runtime.transport,
      status: this.runtime.transport.status === "healthy" ? "healthy" : "starting",
      updatedAt: nowIso(),
      resumable: true,
      nextRetryAt: undefined,
    };
    await this.persistRuntime();

    try {
      const updates = await getUpdates(
        credentials.baseUrl,
        credentials.token,
        this.runtime.cursor,
        controller.signal,
      );
      await this.deliverInboundBatch(credentials, updates);
      const successAt = nowIso();
      this.runtime.auth = {
        ...this.runtime.auth,
        status: "authenticated",
        updatedAt: successAt,
        baseUrl: credentials.baseUrl,
        accountId: credentials.accountId,
        botUserId: credentials.userId,
        lastError: undefined,
      };
      this.runtime.transport = {
        ...this.runtime.transport,
        status: "healthy",
        updatedAt: successAt,
        resumable: true,
        consecutiveFailures: 0,
        nextRetryAt: undefined,
        lastSuccessAt: successAt,
        lastError: undefined,
      };
      await this.persistRuntime();
      nextPollDelayMs = 0;
    } catch (error) {
      if (isAbortLikeError(error)) {
        if (this.runtime.enabled && this.runtime.auth.status === "authenticated") {
          this.runtime.transport = {
            ...this.runtime.transport,
            status: "degraded",
            updatedAt: nowIso(),
            resumable: true,
          };
          await this.persistRuntime();
          nextPollDelayMs = 0;
        }
      } else if (isTimeoutLikeError(error)) {
        this.runtime.transport = {
          ...this.runtime.transport,
          status: "healthy",
          updatedAt: nowIso(),
          resumable: true,
          nextRetryAt: undefined,
        };
        await this.persistRuntime();
        nextPollDelayMs = 0;
      } else if (isAuthFailure(error)) {
        await this.markReauthRequired("微信会话已过期，请重新登录。");
        return;
      } else {
        await this.markTransportBackoff(error);
        return;
      }
    } finally {
      if (this.updatePollController === controller) {
        this.updatePollController = null;
      }
      if (
        nextPollDelayMs !== null &&
        this.runtime.enabled &&
        this.runtime.auth.status === "authenticated" &&
        this.runtime.credentials
      ) {
        this.scheduleUpdatePoll(nextPollDelayMs);
      }
    }
  }

  private async pollLogin(qrCode: string): Promise<void> {
    await this.ensureReady();
    const baseUrl = this.runtime.auth.baseUrl || DEFAULT_BASE_URL;
    try {
      const status = await pollQrStatus(baseUrl, qrCode);
      if (status.status === "confirmed") {
        if (
          !status.bot_token ||
          !status.ilink_bot_id ||
          !status.ilink_user_id
        ) {
          this.runtime.auth = {
            status: "reauth_required",
            updatedAt: nowIso(),
            baseUrl,
            lastError: "二维码已确认，但未返回完整凭据",
          };
          this.runtime.credentials = null;
          this.runtime.transport = {
            ...this.runtime.transport,
            status: "stopped",
            updatedAt: nowIso(),
            resumable: false,
          };
          await this.persistRuntime();
          return;
        }
        const credentials: WechatCredentials = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
        };
        this.runtime.credentials = credentials;
        this.runtime.auth = {
          status: "authenticated",
          updatedAt: nowIso(),
          baseUrl: credentials.baseUrl,
          accountId: credentials.accountId,
          botUserId: credentials.userId,
        };
        this.runtime.transport = {
          ...this.runtime.transport,
          status: this.runtime.enabled ? "starting" : "stopped",
          updatedAt: nowIso(),
          resumable: true,
          consecutiveFailures: 0,
          nextRetryAt: undefined,
          lastError: undefined,
        };
        this.clearLoginPoll();
        await this.persistRuntime();
        if (this.runtime.enabled) {
          this.ensureUpdatePoll();
        }
        return;
      }
      if (status.status === "expired") {
        this.clearLoginPoll();
        this.runtime.credentials = null;
        this.runtime.cursor = "";
        this.runtime.contextTokens = {};
        this.runtime.auth = {
          status: "logged_out",
          updatedAt: nowIso(),
          lastError: "二维码已过期，请重新开始登录。",
        };
        this.runtime.transport = {
          ...this.runtime.transport,
          status: "stopped",
          updatedAt: nowIso(),
          resumable: false,
          nextRetryAt: undefined,
        };
        await this.persistRuntime();
        return;
      }
      this.runtime.auth = {
        ...this.runtime.auth,
        status: "pending_qr",
        updatedAt: nowIso(),
        lastError: undefined,
      };
      await this.persistRuntime();
      this.scheduleLoginPoll(qrCode);
    } catch (error) {
      this.runtime.auth = {
        ...this.runtime.auth,
        status: "pending_qr",
        updatedAt: nowIso(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      await this.persistRuntime();
      this.scheduleLoginPoll(qrCode);
    }
  }

  async getState(): Promise<WechatHostStateSnapshot> {
    await this.ensureReady();
    return buildSnapshot(this.runtime);
  }

  async resume(reason = "manual"): Promise<WechatHostStateSnapshot> {
    await this.ensureReady();
    this.runtime.resume = {
      resumable: deriveResumable(this.runtime),
      lastResumeAt: nowIso(),
      lastResumeReason: reason,
    };
    if (this.runtime.auth.status === "pending_qr" && this.runtime.auth.qrCode) {
      this.scheduleLoginPoll(this.runtime.auth.qrCode);
      return this.persistRuntime();
    }
    if (!this.runtime.enabled) {
      this.clearUpdatePoll();
      this.markTransportStopped();
      return this.persistRuntime();
    }
    if (this.runtime.auth.status === "authenticated" && this.runtime.credentials) {
      this.runtime.transport = {
        ...this.runtime.transport,
        status: "starting",
        updatedAt: nowIso(),
        resumable: true,
        nextRetryAt: undefined,
      };
      this.ensureUpdatePoll();
      return this.persistRuntime();
    }
    this.markTransportStopped();
    return this.persistRuntime();
  }

  async enable(): Promise<WechatHostStateSnapshot> {
    await this.ensureReady();
    this.runtime.enabled = true;
    if (this.runtime.auth.status === "authenticated" && this.runtime.credentials) {
      this.runtime.transport = {
        ...this.runtime.transport,
        status: "degraded",
        updatedAt: nowIso(),
        resumable: true,
      };
    }
    return this.persistRuntime();
  }

  async disable(): Promise<WechatHostStateSnapshot> {
    await this.ensureReady();
    this.clearUpdatePoll();
    this.runtime.enabled = false;
    this.markTransportStopped();
    return this.persistRuntime();
  }

  async startLogin(): Promise<WechatHostStateSnapshot> {
    await this.ensureReady();
    this.clearLoginPoll();
    this.clearUpdatePoll();
    const qr = await fetchQrCode(DEFAULT_BASE_URL);
    this.runtime.credentials = null;
    this.runtime.cursor = "";
    this.runtime.contextTokens = {};
    this.runtime.auth = {
      status: "pending_qr",
      updatedAt: nowIso(),
      qrCode: qr.qrcode,
      qrImageUrl: qr.qrcode_img_content,
      baseUrl: DEFAULT_BASE_URL,
    };
    this.runtime.transport = {
      ...this.runtime.transport,
      status: "stopped",
      updatedAt: nowIso(),
      resumable: true,
      consecutiveFailures: 0,
      nextRetryAt: undefined,
      lastError: undefined,
    };
    this.scheduleLoginPoll(qr.qrcode);
    return this.persistRuntime();
  }

  async logout(): Promise<WechatHostStateSnapshot> {
    await this.ensureReady();
    this.clearLoginPoll();
    this.clearUpdatePoll();
    this.runtime.enabled = false;
    this.runtime.credentials = null;
    this.runtime.cursor = "";
    this.runtime.contextTokens = {};
    this.runtime.auth = {
      status: "logged_out",
      updatedAt: nowIso(),
    };
    this.runtime.transport = {
      ...this.runtime.transport,
      status: "stopped",
      updatedAt: nowIso(),
      resumable: false,
      consecutiveFailures: 0,
      nextRetryAt: undefined,
      lastError: undefined,
    };
    this.runtime.resume = {
      resumable: false,
      lastResumeAt: this.runtime.resume.lastResumeAt,
      lastResumeReason: this.runtime.resume.lastResumeReason,
    };
    return this.persistRuntime();
  }

  async sendReply(input: WechatReplySendInput): Promise<WechatReplySendResult> {
    await this.ensureReady();
    if (!this.runtime.enabled) {
      throw new Error("WeChat 通道未启用，无法发送回复");
    }
    if (this.runtime.auth.status !== "authenticated" || !this.runtime.credentials) {
      throw new Error("WeChat 未登录，无法发送回复");
    }
    this.runtime.contextTokens = pruneContextTokens(this.runtime.contextTokens);
    await this.persistRuntime({ emit: false });

    const tokenEntry = this.runtime.contextTokens[input.userId];
    const contextToken = String(tokenEntry?.token || "").trim();
    if (!contextToken) {
      throw new Error(`缺少用户 ${input.userId} 的 context_token，无法发送回复`);
    }

    let deliveredPartCount = 0;
    for (const part of input.parts) {
      if (part.kind !== "text") continue;
      try {
        await sendTextMessage({
          baseUrl: this.runtime.credentials.baseUrl,
          token: this.runtime.credentials.token,
          fromUserId: this.runtime.credentials.userId,
          userId: input.userId,
          contextToken,
          text: part.text,
          clientId: part.clientId,
        });
        deliveredPartCount += 1;
      } catch (error) {
        return {
          deliveryId: input.deliveryId,
          sentAt: nowIso(),
          deliveredPartCount,
          complete: false,
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const sentAt = nowIso();
    this.runtime.sendLog = [
      ...this.runtime.sendLog.slice(-(SEND_LOG_MAX_ENTRIES - 1)),
      {
        deliveryId: input.deliveryId,
        channelTurnId: input.channelTurnId,
        sessionId: input.sessionId,
        parts: input.parts,
        sentAt,
      },
    ];
    await this.persistRuntime({ emit: false });
    return {
      deliveryId: input.deliveryId,
      sentAt,
      deliveredPartCount,
      complete: true,
    };
  }
}
