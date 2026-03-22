import {
  HOST_PROTOCOL_VERSION,
  type WechatReplySendInput,
  type WechatReplySendResult,
  type WechatHostStateSnapshot,
} from "../sw/kernel/host-protocol";
import {
  DEFAULT_BASE_URL,
  fetchQrCode,
  pollQrStatus,
  type WechatCredentials,
} from "./wechat-api";

const WECHAT_STATE_KEY = "bbl.wechat.host.state.v1";
const WECHAT_SEND_LOG_KEY = "bbl.wechat.host.send-log.v1";
const WECHAT_CREDENTIALS_KEY = "bbl.wechat.host.credentials.v1";
const QR_POLL_INTERVAL_MS = 2_000;

function nowIso(): string {
  return new Date().toISOString();
}

function createInitialState(): WechatHostStateSnapshot {
  return {
    hostEpoch: crypto.randomUUID(),
    protocolVersion: HOST_PROTOCOL_VERSION,
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

function readState(): WechatHostStateSnapshot {
  try {
    const raw = localStorage.getItem(WECHAT_STATE_KEY);
    const credentials = readCredentials();
    if (!raw) {
      const initial = createInitialState();
      if (!credentials) return initial;
      return {
        ...initial,
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

  private clearLoginPoll(): void {
    if (!this.loginPollTimer) return;
    clearTimeout(this.loginPollTimer);
    this.loginPollTimer = null;
  }

  private scheduleLoginPoll(qrCode: string): void {
    this.clearLoginPoll();
    this.loginPollTimer = setTimeout(() => {
      void this.pollLogin(qrCode);
    }, QR_POLL_INTERVAL_MS);
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
    clearCredentials();
    const current = readState();
    return writeState({
      ...current,
      login: {
        status: "logged_out",
        updatedAt: nowIso(),
      },
    });
  }

  sendReply(input: WechatReplySendInput): WechatReplySendResult {
    const sentAt = nowIso();
    appendSendLog(input, sentAt);
    return {
      deliveryId: input.deliveryId,
      sentAt,
    };
  }
}
