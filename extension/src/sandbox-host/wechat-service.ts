import {
  HOST_PROTOCOL_VERSION,
  type WechatHostStateSnapshot,
} from "../sw/kernel/host-protocol";

const WECHAT_STATE_KEY = "bbl.wechat.host.state.v1";

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
}
