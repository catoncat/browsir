import { defineStore } from "pinia";
import { ref } from "vue";
import { sendMessage } from "./send-message";

export interface WechatPanelState {
  hostEpoch: string;
  protocolVersion: string;
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
}

function emptyState(): WechatPanelState {
  return {
    hostEpoch: "",
    protocolVersion: "",
    enabled: false,
    login: {
      status: "logged_out",
      updatedAt: "",
    },
  };
}

function normalizeWechatState(raw: unknown): WechatPanelState {
  const row =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const loginRow =
    row.login && typeof row.login === "object"
      ? (row.login as Record<string, unknown>)
      : {};
  const status = String(loginRow.status || "").trim();

  return {
    hostEpoch: String(row.hostEpoch || "").trim(),
    protocolVersion: String(row.protocolVersion || "").trim(),
    enabled: row.enabled === true,
    login: {
      status:
        status === "pending" ||
        status === "logged_in" ||
        status === "error"
          ? status
          : "logged_out",
      updatedAt: String(loginRow.updatedAt || "").trim(),
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
}

export const useWechatStore = defineStore("wechat-store", () => {
  const state = ref<WechatPanelState>(emptyState());
  const loading = ref(false);
  const error = ref("");

  async function refresh() {
    loading.value = true;
    error.value = "";
    try {
      state.value = normalizeWechatState(await sendMessage<WechatPanelState>(
        "brain.channel.wechat.get_state",
      ));
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function startLogin() {
    loading.value = true;
    error.value = "";
    try {
      state.value = normalizeWechatState(await sendMessage<WechatPanelState>(
        "brain.channel.wechat.login.start",
      ));
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function logout() {
    loading.value = true;
    error.value = "";
    try {
      state.value = normalizeWechatState(await sendMessage<WechatPanelState>(
        "brain.channel.wechat.logout",
      ));
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function enable() {
    loading.value = true;
    error.value = "";
    try {
      state.value = normalizeWechatState(await sendMessage<WechatPanelState>(
        "brain.channel.wechat.enable",
      ));
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function disable() {
    loading.value = true;
    error.value = "";
    try {
      state.value = normalizeWechatState(await sendMessage<WechatPanelState>(
        "brain.channel.wechat.disable",
      ));
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  return {
    state,
    loading,
    error,
    refresh,
    startLogin,
    logout,
    enable,
    disable,
  };
});
