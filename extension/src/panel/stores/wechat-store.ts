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

export const useWechatStore = defineStore("wechat-store", () => {
  const state = ref<WechatPanelState>(emptyState());
  const loading = ref(false);
  const error = ref("");

  async function refresh() {
    loading.value = true;
    error.value = "";
    try {
      state.value = await sendMessage<WechatPanelState>(
        "brain.channel.wechat.get_state",
      );
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
      state.value = await sendMessage<WechatPanelState>(
        "brain.channel.wechat.login.start",
      );
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
      state.value = await sendMessage<WechatPanelState>(
        "brain.channel.wechat.logout",
      );
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
      state.value = await sendMessage<WechatPanelState>(
        "brain.channel.wechat.enable",
      );
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
      state.value = await sendMessage<WechatPanelState>(
        "brain.channel.wechat.disable",
      );
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
