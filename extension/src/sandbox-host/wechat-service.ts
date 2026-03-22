import {
  HOST_PROTOCOL_VERSION,
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

function readContextTokens(): Record<string, string> {
  try {
    const raw = localStorage.getItem(WECHAT_CONTEXT_TOKENS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => [String(key), String(value || "").trim()])
        .filter(([key, value]) => key && value),
    );
  } catch {
    return {};
  }
}

function writeContextTokens(tokens: Record<string, string>): void {
  localStorage.setItem(WECHAT_CONTEXT_TOKENS_KEY, JSON.stringify(tokens));
}

function clearContextTokens(): void {
  localStorage.removeItem(WECHAT_CONTEXT_TOKENS_KEY);
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
  return state;
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

  private clearLoginPoll(): void {
    if (!this.loginPollTimer) return;
    clearTimeout(this.loginPollTimer);
    this.loginPollTimer = null;
  }

  private clearUpdatePoll(): void {
    if (this.updatePollTimer) {
      clearTimeout(this.updatePollTimer);
      this.updatePollTimer = null;
    }
    this.updatePollController?.abort();
    this.updatePollController = null;
  }

  private scheduleLoginPoll(qrCode: string): void {
    this.clearLoginPoll();
    this.loginPollTimer = setTimeout(() => {
      void this.pollLogin(qrCode);
    }, QR_POLL_INTERVAL_MS);
  }

  private scheduleUpdatePoll(delayMs = 0): void {
    this.clearUpdatePoll();
    this.updatePollTimer = setTimeout(() => {
      void this.pollUpdates();
    }, delayMs);
  }

  private rememberContext(message: WechatMessage): void {
    const userId =
      message.message_type === 1 ? message.from_user_id : message.to_user_id;
    if (!userId || !message.context_token) return;
    const tokens = readContextTokens();
    tokens[userId] = message.context_token;
    writeContextTokens(tokens);
  }

  private toInboundMessage(message: WechatMessage): Record<string, unknown> | null {
    if (message.message_type !== 1) return null;
    const text = message.item_list
      ?.filter((item) => Number(item.type) === 1)
      .map((item) => String(item.text_item?.text || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) return null;
    return {
      type: "brain.channel.wechat.inbound",
      remoteConversationId: message.from_user_id,
      remoteUserId: message.from_user_id,
      remoteMessageId: String(message.message_id || "").trim(),
      text,
      contextToken: message.context_token,
      receivedAt: new Date(message.create_time_ms).toISOString(),
    };
  }

  private async deliverInboundBatch(
    updates: WechatGetUpdatesResponse,
  ): Promise<void> {
    for (const message of updates.msgs || []) {
      this.rememberContext(message);
      const inbound = this.toInboundMessage(message);
      if (!inbound) continue;
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
    if (!credentials) return;
    const current = readState();
    if (current.login.status !== "logged_in") return;

    try {
      this.updatePollController = new AbortController();
      const updates = await getUpdates(
        credentials.baseUrl,
        credentials.token,
        readCursor(),
        this.updatePollController.signal,
      );
      this.updatePollController = null;
      await this.deliverInboundBatch(updates);
      this.scheduleUpdatePoll(0);
    } catch (error) {
      this.updatePollController = null;
      const err = error as { code?: number; message?: string };
      if (typeof err?.code === "number" && err.code === -14) {
        this.logout();
        writeState({
          ...readState(),
          login: {
            status: "logged_out",
            updatedAt: nowIso(),
            lastError: "微信会话已过期，请重新登录。",
          },
        });
        return;
      }
      writeState({
        ...current,
        login: {
          ...current.login,
          status: "error",
          updatedAt: nowIso(),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      this.scheduleUpdatePoll(2_000);
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
          writeState({
            ...current,
            login: {
              status: "error",
              updatedAt: nowIso(),
              lastError: "二维码已确认，但未返回完整凭据",
            },
          });
          return;
        }
        const credentials: WechatCredentials = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
        };
        writeCredentials(credentials);
        writeState({
          ...current,
          login: {
            status: "logged_in",
            updatedAt: nowIso(),
            baseUrl: credentials.baseUrl,
            accountId: credentials.accountId,
            botUserId: credentials.userId,
          },
        });
        this.clearLoginPoll();
        if (current.enabled) {
          this.scheduleUpdatePoll(0);
        }
        return;
      }
      if (status.status === "expired") {
        writeState({
          ...current,
          login: {
            status: "logged_out",
            updatedAt: nowIso(),
            lastError: "二维码已过期，请重新开始登录。",
          },
        });
        this.clearLoginPoll();
        return;
      }
      this.scheduleLoginPoll(qrCode);
    } catch (error) {
      writeState({
        ...current,
        login: {
          ...current.login,
          status: "error",
          updatedAt: nowIso(),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      this.clearLoginPoll();
    }
  }

  getState(): WechatHostStateSnapshot {
    return readState();
  }

  enable(): WechatHostStateSnapshot {
    const current = readState();
    const next = writeState({
      ...current,
      enabled: true,
    });
    if (next.login.status === "logged_in") {
      this.scheduleUpdatePoll(0);
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
    const sentAt = nowIso();
    const current = readState();
    if (!current.enabled) {
      throw new Error("WeChat 通道未启用，无法发送回复");
    }
    const credentials = readCredentials();
    if (!credentials) {
      throw new Error("WeChat 未登录，无法发送回复");
    }
    const tokens = readContextTokens();
    const contextToken = tokens[input.userId];
    if (!contextToken) {
      throw new Error(`缺少用户 ${input.userId} 的 context_token，无法发送回复`);
    }
    for (const part of input.parts) {
      if (part.kind !== "text") continue;
      await sendTextMessage({
        baseUrl: credentials.baseUrl,
        token: credentials.token,
        userId: input.userId,
        contextToken,
        text: part.text,
      });
    }
    appendSendLog(input, sentAt);
    return {
      deliveryId: input.deliveryId,
      sentAt,
    };
  }
}
