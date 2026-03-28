import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  HOST_PROTOCOL_VERSION,
  type WechatHostStateSnapshot,
} from "../../sw/kernel/host-protocol";
import { sendMessage } from "./send-message";

export type WechatPanelState = WechatHostStateSnapshot;

export type WechatUserStatus =
  | "loading"
  | "idle"
  | "connecting_qr"
  | "connected"
  | "reconnecting"
  | "error";

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
    protocolVersion: HOST_PROTOCOL_VERSION,
    enabled: false,
    auth: {
      status: "logged_out",
      updatedAt: "",
    },
    transport: {
      status: "stopped",
      updatedAt: "",
      resumable: false,
      consecutiveFailures: 0,
    },
    resume: {
      resumable: false,
    },
  };
}

function normalizeWechatState(raw: unknown): WechatPanelState {
  const row =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const authRow =
    row.auth && typeof row.auth === "object"
      ? (row.auth as Record<string, unknown>)
      : {};
  const transportRow =
    row.transport && typeof row.transport === "object"
      ? (row.transport as Record<string, unknown>)
      : {};
  const resumeRow =
    row.resume && typeof row.resume === "object"
      ? (row.resume as Record<string, unknown>)
      : {};
  const authStatus = String(authRow.status || "").trim();
  const transportStatus = String(transportRow.status || "").trim();

  return {
    hostEpoch: String(row.hostEpoch || "").trim(),
    protocolVersion: HOST_PROTOCOL_VERSION,
    enabled: row.enabled === true,
    auth: {
      status:
        authStatus === "pending_qr" ||
        authStatus === "authenticated" ||
        authStatus === "reauth_required"
          ? authStatus
          : "logged_out",
      updatedAt: String(authRow.updatedAt || "").trim(),
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
      status:
        transportStatus === "starting" ||
        transportStatus === "healthy" ||
        transportStatus === "backing_off" ||
        transportStatus === "degraded"
          ? transportStatus
          : "stopped",
      updatedAt: String(transportRow.updatedAt || "").trim(),
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
      nextState.auth.status === "pending_qr" ||
      (nextState.enabled && nextState.auth.status === "authenticated");
    if (!shouldPoll) {
      clearRefreshTimer();
      return;
    }
    const delayMs =
      nextState.auth.status === "pending_qr"
        ? 1200
        : nextState.transport.status === "healthy"
          ? 4000
          : 1500;
    scheduleRefresh(delayMs);
  }

  function applyHostState(
    raw: unknown,
    options: { clearError?: boolean } = {},
  ) {
    state.value = normalizeWechatState(raw);
    ready.value = true;
    const hasHostError =
      state.value.auth.status === "reauth_required" ||
      !!String(
        state.value.transport.lastError || state.value.auth.lastError || "",
      ).trim();
    if (options.clearError !== false && !hasHostError) {
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
        await sendMessage<WechatPanelState>("brain.channel.wechat.get_state"),
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
        await sendMessage<WechatPanelState>("brain.channel.wechat.login.start"),
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
        await sendMessage<WechatPanelState>("brain.channel.wechat.logout"),
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
        await sendMessage<WechatPanelState>("brain.channel.wechat.enable"),
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
        await sendMessage<WechatPanelState>("brain.channel.wechat.disable"),
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }

  async function resume(reason = "manual") {
    loading.value = true;
    error.value = "";
    try {
      applyHostState(
        await sendMessage<WechatPanelState>("brain.channel.wechat.resume", {
          reason,
        }),
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      clearRefreshTimer();
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }

  async function connect() {
    loading.value = true;
    error.value = "";
    try {
      let nextState = state.value;
      if (!nextState.enabled) {
        nextState = normalizeWechatState(
          await sendMessage<WechatPanelState>("brain.channel.wechat.enable"),
        );
      }
      const shouldResume =
        nextState.auth.status === "authenticated" ||
        nextState.auth.status === "pending_qr";
      nextState = normalizeWechatState(
        shouldResume
          ? await sendMessage<WechatPanelState>("brain.channel.wechat.resume", {
              reason: "panel_connect",
            })
          : await sendMessage<WechatPanelState>(
              "brain.channel.wechat.login.start",
            ),
      );
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
        nextState.enabled ||
        nextState.auth.status !== "logged_out" ||
        nextState.resume.resumable ||
        nextState.auth.qrCode ||
        nextState.auth.qrImageUrl
      ) {
        nextState = normalizeWechatState(
          await sendMessage<WechatPanelState>("brain.channel.wechat.logout"),
        );
      }
      nextState = normalizeWechatState(
        await sendMessage<WechatPanelState>("brain.channel.wechat.disable"),
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
        badge: "读取中",
        primaryActionLabel: "读取状态...",
        primaryActionDisabled: true,
        showSecondaryAction: false,
        secondaryActionLabel: "断开微信",
        showQrCard: false,
        qrHint: "正在准备二维码",
        errorMessage: "",
      };
    }

    if (
      state.value.auth.status === "authenticated" &&
      state.value.enabled &&
      state.value.transport.status === "healthy"
    ) {
      return {
        status: "connected",
        headline: "微信已连接",
        detail: "新消息会自动同步到当前通道。",
        badge: "已连接",
        primaryActionLabel: "已连接",
        primaryActionDisabled: true,
        showSecondaryAction: true,
        secondaryActionLabel: "断开微信",
        showQrCard: false,
        qrHint: "",
        errorMessage: "",
      };
    }

    if (state.value.auth.status === "authenticated" && state.value.enabled) {
      return {
        status: "reconnecting",
        headline: "微信正在恢复连接",
        detail:
          state.value.transport.status === "backing_off"
            ? "连接暂时中断，系统会自动退避重试。"
            : "正在恢复轮询连接，历史绑定和登录态会继续复用。",
        badge: "重连中",
        primaryActionLabel:
          state.value.transport.status === "backing_off" ? "立即重连" : "恢复连接",
        primaryActionDisabled: false,
        showSecondaryAction: true,
        secondaryActionLabel: "断开微信",
        showQrCard: false,
        qrHint: "",
        errorMessage:
          error.value ||
          String(
            state.value.transport.lastError || state.value.auth.lastError || "",
          ).trim(),
      };
    }

    if (state.value.auth.status === "pending_qr") {
      return {
        status: "connecting_qr",
        headline: "等待微信扫码",
        detail: "请使用微信扫码完成连接，页面会自动刷新连接结果。",
        badge: "待扫码",
        primaryActionLabel: "重新生成二维码",
        primaryActionDisabled: false,
        showSecondaryAction: true,
        secondaryActionLabel: "断开微信",
        showQrCard: Boolean(state.value.auth.qrImageUrl),
        qrHint: "使用微信扫码完成登录",
        errorMessage:
          error.value || String(state.value.auth.lastError || "").trim(),
      };
    }

    if (state.value.auth.status === "reauth_required") {
      return {
        status: "error",
        headline: "微信需要重新登录",
        detail: "当前登录态已失效，需要重新扫码建立连接。",
        badge: "需重登",
        primaryActionLabel: "重新登录微信",
        primaryActionDisabled: false,
        showSecondaryAction: state.value.enabled,
        secondaryActionLabel: "断开微信",
        showQrCard: false,
        qrHint: "",
        errorMessage:
          error.value ||
          String(
            state.value.auth.lastError || state.value.transport.lastError || "",
          ).trim(),
      };
    }

    return {
      status: "idle",
      headline: "连接微信",
      detail:
        state.value.auth.status === "authenticated"
          ? "当前微信授权仍在，点击即可恢复连接。"
          : "连接后即可通过微信收发消息。",
      badge: "未连接",
      primaryActionLabel:
        state.value.auth.status === "authenticated" ? "恢复连接" : "连接微信",
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
    resume,
    connect,
    disconnect,
  };
});
