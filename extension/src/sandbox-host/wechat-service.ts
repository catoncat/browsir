import {
  HOST_PROTOCOL_VERSION,
  type WechatReplySendInput,
  type WechatReplySendResult,
  type WechatHostStateSnapshot,
} from "../sw/kernel/host-protocol";

const WECHAT_STATE_KEY = "bbl.wechat.host.state.v1";
const WECHAT_SEND_LOG_KEY = "bbl.wechat.host.send-log.v1";

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

function readState(): WechatHostStateSnapshot {
  try {
    const raw = localStorage.getItem(WECHAT_STATE_KEY);
    if (!raw) return createInitialState();
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
  getState(): WechatHostStateSnapshot {
    return readState();
  }

  startLogin(): WechatHostStateSnapshot {
    const current = readState();
    return writeState({
      ...current,
      login: {
        status: "pending",
        updatedAt: nowIso(),
      },
    });
  }

  logout(): WechatHostStateSnapshot {
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
