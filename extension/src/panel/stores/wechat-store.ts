import { defineStore } from "pinia";
import { computed, ref } from "vue";
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

export type WechatUserStatus = "loading" | "idle" | "connecting_qr" | "connected" | "error";

export interface WechatUserViewState {
  status: WechatUserStatus;
  headline: string;
  detail: string;
  badge: string;
  primaryActionLabel: string;
  primaryActionDisabled: boolean;
  showSecondaryAction: boolean;
  secondaryActionLabel: string;
  showQrCard: boolean;
  qrHint: string;
  errorMessage: string;
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
  const ready = ref(false);
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRefreshTimer() {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  function scheduleRefresh(delayMs = 1500) {
    clearRefreshTimer();
    refreshTimer = setTimeout(() => {
      void refresh({ silent: true });
    }, delayMs);
  }

  function reconcileRefreshLoop(nextState: WechatPanelState) {
    const shouldPoll =
      nextState.login.status === "pending" ||
      (nextState.enabled && nextState.login.status === "logged_in");
    if (!shouldPoll) {
      clearRefreshTimer();
      return;
    }
    scheduleRefresh(nextState.login.status === "pending" ? 1200 : 4000);
  }

  function applyHostState(
    raw: unknown,
    options: { clearError?: boolean } = {},
  ) {
    state.value = normalizeWechatState(raw);
    ready.value = true;
    if (options.clearError !== false && state.value.login.status !== "error") {
      error.value = "";
    }
    reconcileRefreshLoop(state.value);
  }

  async function refresh(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      loading.value = true;
      error.value = "";
    }
    try {
      applyHostState(
        await sendMessage<WechatPanelState>(
          "brain.channel.wechat.get_state",
        ),
      );
    } catch (err) {
      if (!options.silent) {
        error.value = err instanceof Error ? err.message : String(err);
      }
      clearRefreshTimer();
    } finally {
      ready.value = true;
      if (!options.silent) {
        loading.value = false;
      }
    }
  }

  async function startLogin() {
    loading.value = true;
    error.value = "";
    try {
      applyHostState(
        await sendMessage<WechatPanelState>(
          "brain.channel.wechat.login.start",
        ),
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      clearRefreshTimer();
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }

  async function logout() {
    loading.value = true;
    error.value = "";
    try {
      applyHostState(
        await sendMessage<WechatPanelState>(
          "brain.channel.wechat.logout",
        ),
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }

  async function enable() {
    loading.value = true;
    error.value = "";
    try {
      applyHostState(
        await sendMessage<WechatPanelState>(
          "brain.channel.wechat.enable",
        ),
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }

  async function disable() {
    loading.value = true;
    error.value = "";
    try {
      applyHostState(
        await sendMessage<WechatPanelState>(
          "brain.channel.wechat.disable",
        ),
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }

  async function connect() {
    loading.value = true;
    error.value = "";
    try {
      const wasEnabled = state.value.enabled;
      let nextState = state.value;
      if (!nextState.enabled) {
        nextState = normalizeWechatState(
          await sendMessage<WechatPanelState>(
            "brain.channel.wechat.enable",
          ),
        );
      }
      const shouldStartFreshLogin =
        !wasEnabled || nextState.login.status !== "logged_in";
      if (shouldStartFreshLogin) {
        nextState = normalizeWechatState(
          await sendMessage<WechatPanelState>(
            "brain.channel.wechat.login.start",
          ),
        );
      }
      applyHostState(nextState);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      clearRefreshTimer();
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }

  async function disconnect() {
    loading.value = true;
    error.value = "";
    try {
      let nextState = state.value;
      if (
        nextState.login.status !== "logged_out" ||
        nextState.login.qrCode ||
        nextState.login.qrImageUrl
      ) {
        nextState = normalizeWechatState(
          await sendMessage<WechatPanelState>(
            "brain.channel.wechat.logout",
          ),
        );
      }
      nextState = normalizeWechatState(
        await sendMessage<WechatPanelState>(
          "brain.channel.wechat.disable",
        ),
      );
      applyHostState(nextState);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }

  const userView = computed<WechatUserViewState>(() => {
    if (!ready.value) {
      return {
        status: "loading",
        headline: "正在读取微信状态",
        detail: "稍等一下，我们正在同步当前连接状态。",
        badge: "loading",
        primaryActionLabel: "读取状态...",
        primaryActionDisabled: true,
        showSecondaryAction: false,
        secondaryActionLabel: "断开微信",
        showQrCard: false,
        qrHint: "正在准备二维码",
        errorMessage: "",
      };
    }

    if (state.value.login.status === "logged_in" && state.value.enabled) {
      return {
        status: "connected",
        headline: "微信已连接",
        detail: "新消息会自动同步到当前通道。",
        badge: "connected",
        primaryActionLabel: "已连接",
        primaryActionDisabled: true,
        showSecondaryAction: true,
        secondaryActionLabel: "断开微信",
        showQrCard: false,
        qrHint: "",
        errorMessage: "",
      };
    }

    if (state.value.login.status === "pending") {
      return {
        status: "connecting_qr",
        headline: "等待微信扫码",
        detail: "请使用微信扫码完成连接，页面会自动刷新连接结果。",
        badge: "connecting",
        primaryActionLabel: "重新生成二维码",
        primaryActionDisabled: false,
        showSecondaryAction: true,
        secondaryActionLabel: "断开微信",
        showQrCard: Boolean(state.value.login.qrImageUrl),
        qrHint: "使用微信扫码完成登录",
        errorMessage: error.value,
      };
    }

    if (state.value.login.status === "error") {
      return {
        status: "error",
        headline: "微信连接异常",
        detail: "重新连接后会生成新的二维码。",
        badge: "error",
        primaryActionLabel: "重新连接微信",
        primaryActionDisabled: false,
        showSecondaryAction: state.value.enabled,
        secondaryActionLabel: "断开微信",
        showQrCard: false,
        qrHint: "",
        errorMessage: error.value || String(state.value.login.lastError || "").trim(),
      };
    }

    const detail =
      state.value.login.status === "logged_in"
        ? "当前微信已准备好，点击即可恢复连接。"
        : "连接后即可通过微信收发消息。";

    return {
      status: "idle",
      headline: "连接微信",
      detail,
      badge: "idle",
      primaryActionLabel: "连接微信",
      primaryActionDisabled: false,
      showSecondaryAction: false,
      secondaryActionLabel: "断开微信",
      showQrCard: false,
      qrHint: "",
      errorMessage: error.value,
    };
  });

  return {
    state,
    loading,
    error,
    ready,
    userView,
    applyHostState,
    refresh,
    startLogin,
    logout,
    enable,
    disable,
    connect,
    disconnect,
  };
});
