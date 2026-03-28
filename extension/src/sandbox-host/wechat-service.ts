import {
  HOST_PROTOCOL_VERSION,
  WECHAT_HOST_STATE_EVENT_TYPE,
  type WechatReplySendInput,
  type WechatReplySendResult,
  type WechatHostStateSnapshot,
} from "../sw/kernel/host-protocol";
import {
  DEFAULT_BASE_URL,
  fetchQrCode,
  getUpdates,
  pollQrStatus,
  sendTextMessage,
  type WechatGetUpdatesResponse,
  type WechatMessage,
  type WechatCredentials,
} from "./wechat-api";

const WECHAT_STATE_KEY = "bbl.wechat.host.state.v1";
const WECHAT_SEND_LOG_KEY = "bbl.wechat.host.send-log.v1";
const WECHAT_CREDENTIALS_KEY = "bbl.wechat.host.credentials.v1";
const WECHAT_CURSOR_KEY = "bbl.wechat.host.cursor.v1";
const WECHAT_CONTEXT_TOKENS_KEY = "bbl.wechat.host.context-tokens.v1";
const QR_POLL_INTERVAL_MS = 2_000;
const CONTEXT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONTEXT_TOKEN_MAX_ENTRIES = 200;

interface ContextTokenEntry {
  token: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createInitialState(): WechatHostStateSnapshot {
  return {
    hostEpoch: crypto.randomUUID(),
    protocolVersion: HOST_PROTOCOL_VERSION,
    enabled: false,
    login: {
      status: "logged_out",
      updatedAt: nowIso(),
    },
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

function readCredentials(): WechatCredentials | null {
  try {
    const raw = localStorage.getItem(WECHAT_CREDENTIALS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isWechatCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCredentials(credentials: WechatCredentials): void {
  localStorage.setItem(WECHAT_CREDENTIALS_KEY, JSON.stringify(credentials));
}

function clearCredentials(): void {
  localStorage.removeItem(WECHAT_CREDENTIALS_KEY);
}

function readCursor(): string {
  return String(localStorage.getItem(WECHAT_CURSOR_KEY) || "").trim();
}

function writeCursor(cursor: string): void {
  localStorage.setItem(WECHAT_CURSOR_KEY, String(cursor || ""));
}

function clearCursor(): void {
  localStorage.removeItem(WECHAT_CURSOR_KEY);
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
          now - Date.parse(value.updatedAt) <= CONTEXT_TOKEN_TTL_MS,
      )
      .sort(
        (a, b) =>
          Date.parse(b[1]!.updatedAt) - Date.parse(a[1]!.updatedAt),
      )
      .slice(0, CONTEXT_TOKEN_MAX_ENTRIES)
      .map(([userId, value]) => [userId, value!] as const),
  );
}

function readContextTokens(): Record<string, ContextTokenEntry> {
  try {
    const raw = localStorage.getItem(WECHAT_CONTEXT_TOKENS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return pruneContextTokens(parsed as Record<string, ContextTokenEntry>);
  } catch {
    return {};
  }
}

function writeContextTokens(tokens: Record<string, ContextTokenEntry>): void {
  localStorage.setItem(
    WECHAT_CONTEXT_TOKENS_KEY,
    JSON.stringify(pruneContextTokens(tokens)),
  );
}

function clearContextTokens(): void {
  localStorage.removeItem(WECHAT_CONTEXT_TOKENS_KEY);
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

function readState(): WechatHostStateSnapshot {
  try {
    const raw = localStorage.getItem(WECHAT_STATE_KEY);
    const credentials = readCredentials();
    if (!raw) {
      const initial = createInitialState();
      if (!credentials) return initial;
      return {
        ...initial,
        enabled: false,
        login: {
          status: "logged_in",
          updatedAt: nowIso(),
          baseUrl: credentials.baseUrl,
          accountId: credentials.accountId,
          botUserId: credentials.userId,
        },
      };
    }
    const parsed = JSON.parse(raw) as Partial<WechatHostStateSnapshot>;
    return {
      hostEpoch: String(parsed.hostEpoch || "").trim() || crypto.randomUUID(),
      protocolVersion: HOST_PROTOCOL_VERSION,
      enabled: parsed.enabled === true,
      login: {
        status:
          parsed.login?.status === "pending" ||
          parsed.login?.status === "logged_in" ||
          parsed.login?.status === "error"
            ? parsed.login.status
            : "logged_out",
        updatedAt:
          typeof parsed.login?.updatedAt === "string"
            ? parsed.login.updatedAt
            : nowIso(),
        ...(typeof parsed.login?.lastError === "string" &&
        parsed.login.lastError.trim()
          ? { lastError: parsed.login.lastError.trim() }
          : {}),
        ...(typeof parsed.login?.qrCode === "string" && parsed.login.qrCode.trim()
          ? { qrCode: parsed.login.qrCode.trim() }
          : {}),
        ...(typeof parsed.login?.qrImageUrl === "string" &&
        parsed.login.qrImageUrl.trim()
          ? { qrImageUrl: parsed.login.qrImageUrl.trim() }
          : {}),
        ...(typeof parsed.login?.baseUrl === "string" && parsed.login.baseUrl.trim()
          ? { baseUrl: parsed.login.baseUrl.trim() }
          : credentials?.baseUrl
            ? { baseUrl: credentials.baseUrl }
            : {}),
        ...(typeof parsed.login?.accountId === "string" &&
        parsed.login.accountId.trim()
          ? { accountId: parsed.login.accountId.trim() }
          : credentials?.accountId
            ? { accountId: credentials.accountId }
            : {}),
        ...(typeof parsed.login?.botUserId === "string" &&
        parsed.login.botUserId.trim()
          ? { botUserId: parsed.login.botUserId.trim() }
          : credentials?.userId
            ? { botUserId: credentials.userId }
            : {}),
      },
    };
  } catch {
    return createInitialState();
  }
}

function writeState(state: WechatHostStateSnapshot): WechatHostStateSnapshot {
  localStorage.setItem(WECHAT_STATE_KEY, JSON.stringify(state));
  queueMicrotask(() => {
    void globalThis.chrome?.runtime?.sendMessage?.({
      type: WECHAT_HOST_STATE_EVENT_TYPE,
      payload: state,
    })?.catch(() => {});
  });
  return state;
}

function updateState(
  updater: (current: WechatHostStateSnapshot) => WechatHostStateSnapshot,
): WechatHostStateSnapshot {
  return writeState(updater(readState()));
}

function appendSendLog(payload: WechatReplySendInput, sentAt: string): void {
  const raw = localStorage.getItem(WECHAT_SEND_LOG_KEY);
  let list: unknown[] = [];
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  const next = [
    ...list.slice(-19),
    {
      deliveryId: payload.deliveryId,
      channelTurnId: payload.channelTurnId,
      sessionId: payload.sessionId,
      parts: payload.parts,
      sentAt,
    },
  ];
  localStorage.setItem(WECHAT_SEND_LOG_KEY, JSON.stringify(next));
}

export class WechatHostService {
  private loginPollTimer: ReturnType<typeof setTimeout> | null = null;
  private updatePollTimer: ReturnType<typeof setTimeout> | null = null;
  private updatePollController: AbortController | null = null;
  private updatePollDueAt: number | null = null;

  constructor() {
    this.resumePersistedBackgroundWork();
  }

  private resumePersistedBackgroundWork(): void {
    const state = readState();
    if (state.login.status === "pending" && state.login.qrCode) {
      this.scheduleLoginPoll(state.login.qrCode);
      return;
    }
    if (
      state.enabled &&
      state.login.status === "logged_in" &&
      readCredentials()
    ) {
      this.scheduleUpdatePoll(0);
    }
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
  ): void {
    const userId = resolvePeerUserIdForContext(credentials, message);
    if (!userId || !message.context_token) return;
    const tokens = readContextTokens();
    tokens[userId] = {
      token: message.context_token,
      updatedAt: nowIso(),
    };
    writeContextTokens(tokens);
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
    for (const message of updates.msgs || []) {
      this.rememberContext(credentials, message);
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
      writeCursor(updates.get_updates_buf);
    }
  }

  private async pollUpdates(): Promise<void> {
    const credentials = readCredentials();
    if (!credentials) {
      console.warn("[wechat] pollUpdates: no credentials, skip");
      return;
    }
    const current = readState();
    if (current.login.status !== "logged_in") {
      console.warn("[wechat] pollUpdates: not logged_in, skip", current.login.status);
      return;
    }

    let nextPollDelayMs: number | null = null;
    const controller = new AbortController();
    this.updatePollController = controller;
    try {
      const updates = await getUpdates(
        credentials.baseUrl,
        credentials.token,
        readCursor(),
        controller.signal,
      );
      await this.deliverInboundBatch(credentials, updates);
      nextPollDelayMs = 0;
    } catch (error) {
      if (isAbortLikeError(error)) {
        nextPollDelayMs = 0;
      } else if (isTimeoutLikeError(error)) {
        nextPollDelayMs = 0;
      } else {
        const err = error as { code?: number; message?: string };
        if (typeof err?.code === "number" && err.code === -14) {
          this.logout();
          updateState((state) => ({
            ...state,
            login: {
              status: "logged_out",
              updatedAt: nowIso(),
              lastError: "微信会话已过期，请重新登录。",
            },
          }));
          return;
        }
        updateState((state) => ({
          ...state,
          login: {
            ...state.login,
            status: "error",
            updatedAt: nowIso(),
            lastError: error instanceof Error ? error.message : String(error),
          },
        }));
        nextPollDelayMs = 2_000;
      }
    } finally {
      if (this.updatePollController === controller) {
        this.updatePollController = null;
      }
      if (nextPollDelayMs !== null && readState().enabled && readCredentials()) {
        this.scheduleUpdatePoll(nextPollDelayMs);
      }
    }
  }

  private async pollLogin(qrCode: string): Promise<void> {
    const current = readState();
    const baseUrl = current.login.baseUrl || DEFAULT_BASE_URL;
    try {
      const status = await pollQrStatus(baseUrl, qrCode);
      if (status.status === "confirmed") {
        if (
          !status.bot_token ||
          !status.ilink_bot_id ||
          !status.ilink_user_id
        ) {
          updateState((state) => ({
            ...state,
            login: {
              status: "error",
              updatedAt: nowIso(),
              lastError: "二维码已确认，但未返回完整凭据",
            },
          }));
          return;
        }
        const credentials: WechatCredentials = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
        };
        writeCredentials(credentials);
        updateState((state) => ({
          ...state,
          login: {
            status: "logged_in",
            updatedAt: nowIso(),
            baseUrl: credentials.baseUrl,
            accountId: credentials.accountId,
            botUserId: credentials.userId,
          },
        }));
        this.clearLoginPoll();
        if (current.enabled) {
          this.ensureUpdatePoll();
        }
        return;
      }
      if (status.status === "expired") {
        updateState((state) => ({
          ...state,
          login: {
            status: "logged_out",
            updatedAt: nowIso(),
            lastError: "二维码已过期，请重新开始登录。",
          },
        }));
        this.clearLoginPoll();
        return;
      }
      this.scheduleLoginPoll(qrCode);
    } catch (error) {
      updateState((state) => ({
        ...state,
        login: {
          ...state.login,
          status: "error",
          updatedAt: nowIso(),
          lastError: error instanceof Error ? error.message : String(error),
        },
      }));
      this.clearLoginPoll();
    }
  }

  getState(): WechatHostStateSnapshot {
    const state = readState();
    if (state.login.status === "pending" && state.login.qrCode) {
      this.scheduleLoginPoll(state.login.qrCode);
      return state;
    }
    if (state.enabled && state.login.status === "logged_in" && readCredentials()) {
      this.ensureUpdatePoll();
    }
    return state;
  }

  enable(): WechatHostStateSnapshot {
    const current = readState();
    const next = writeState({
      ...current,
      enabled: true,
    });
    if (next.login.status === "logged_in") {
      this.ensureUpdatePoll();
    }
    return next;
  }

  disable(): WechatHostStateSnapshot {
    this.clearUpdatePoll();
    const current = readState();
    return writeState({
      ...current,
      enabled: false,
    });
  }

  async startLogin(): Promise<WechatHostStateSnapshot> {
    this.clearLoginPoll();
    this.clearUpdatePoll();
    clearCursor();
    clearContextTokens();
    clearCredentials();
    const current = readState();
    const qr = await fetchQrCode(DEFAULT_BASE_URL);
    const next = writeState({
      ...current,
      login: {
        status: "pending",
        updatedAt: nowIso(),
        qrCode: qr.qrcode,
        qrImageUrl: qr.qrcode_img_content,
        baseUrl: DEFAULT_BASE_URL,
      },
    });
    this.scheduleLoginPoll(qr.qrcode);
    return next;
  }

  logout(): WechatHostStateSnapshot {
    this.clearLoginPoll();
    this.clearUpdatePoll();
    clearCredentials();
    clearCursor();
    clearContextTokens();
    const current = readState();
    return writeState({
      ...current,
      login: {
        status: "logged_out",
        updatedAt: nowIso(),
      },
    });
  }

  async sendReply(input: WechatReplySendInput): Promise<WechatReplySendResult> {
    const current = readState();
    if (!current.enabled) {
      throw new Error("WeChat 通道未启用，无法发送回复");
    }
    const credentials = readCredentials();
    if (!credentials) {
      throw new Error("WeChat 未登录，无法发送回复");
    }
    const tokens = readContextTokens();
    writeContextTokens(tokens);
    const tokenEntry = tokens[input.userId];
    const contextToken = String(tokenEntry?.token || "").trim();
    if (!contextToken) {
      throw new Error(`缺少用户 ${input.userId} 的 context_token，无法发送回复`);
    }
    let deliveredPartCount = 0;
    for (const part of input.parts) {
      if (part.kind !== "text") continue;
      try {
        await sendTextMessage({
          baseUrl: credentials.baseUrl,
          token: credentials.token,
          fromUserId: credentials.userId,
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
    appendSendLog(input, sentAt);
    return {
      deliveryId: input.deliveryId,
      sentAt,
      deliveredPartCount,
      complete: true,
    };
  }
}
