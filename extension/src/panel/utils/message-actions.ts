import { ref, watch, type Ref } from "vue";

export interface PanelMessageLike {
  role?: string;
  content?: string;
  entryId?: string;
}

export interface CopyPayload {
  entryId: string;
  content: string;
  role: string;
}

export interface RetryPayload {
  entryId: string;
}

export interface ForkPayload {
  entryId: string;
}

export interface ActionNotice {
  type: "success" | "error";
  message: string;
}

export interface PendingRegenerateState {
  mode: "retry" | "fork";
  sourceEntryId: string;
  insertAfterUserEntryId: string;
  strategy?: "replace" | "insert";
}

interface UseMessageActionsOptions {
  messages: Ref<PanelMessageLike[]>;
  isRunning: Ref<boolean>;
  regenerateFromAssistantEntry: (entryId: string, options?: { mode?: "fork" | "retry" }) => Promise<{ sessionId: string }>;
}

function isValidAssistantMessage(message: PanelMessageLike) {
  return message.role === "assistant" && String(message.content || "").trim().length > 0;
}

function hasPreviousUserMessage(messages: PanelMessageLike[], index: number) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role !== "user") continue;
    if (String(candidate.content || "").trim().length > 0) return true;
  }
  return false;
}

function isLatestAssistantMessage(messages: PanelMessageLike[], index: number) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role !== "assistant") continue;
    if (!String(candidate.content || "").trim()) continue;
    return i === index;
  }
  return false;
}

function findAssistantIndex(messages: PanelMessageLike[], entryId: string) {
  return messages.findIndex((item) => item?.role === "assistant" && String(item?.entryId || "").trim() === entryId);
}

function findPreviousUserEntryId(messages: PanelMessageLike[], index: number) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role !== "user") continue;
    const entryId = String(candidate?.entryId || "").trim();
    if (!entryId) continue;
    if (!String(candidate?.content || "").trim()) continue;
    return entryId;
  }
  return "";
}

async function writeToClipboard(text: string) {
  const maybeWriter = (globalThis as Record<string, unknown>).__BRAIN_E2E_CLIPBOARD_WRITE;
  if (typeof maybeWriter === "function") {
    await (maybeWriter as (text: string) => Promise<void>)(text);
    return;
  }
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("clipboard unavailable");
}

export function useMessageActions(options: UseMessageActionsOptions) {
  const { messages, isRunning, regenerateFromAssistantEntry } = options;

  const copiedEntryId = ref("");
  const retryingEntryId = ref("");
  const forkingEntryId = ref("");
  const pendingRegenerate = ref<PendingRegenerateState | null>(null);
  const actionNotice = ref<ActionNotice | null>(null);

  // 重生成占位会跟随运行状态结束而清理。
  watch(isRunning, (running) => {
    if (!running) {
      retryingEntryId.value = "";
      forkingEntryId.value = "";
      pendingRegenerate.value = null;
    }
  });

  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearCopiedStateTimer() {
    if (!copiedTimer) return;
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }

  function clearNoticeTimer() {
    if (!noticeTimer) return;
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }

  function showActionNotice(type: "success" | "error", message: string) {
    actionNotice.value = { type, message };
    clearNoticeTimer();
    noticeTimer = setTimeout(() => {
      actionNotice.value = null;
      noticeTimer = null;
    }, 2200);
  }

  function canCopyMessage(message: PanelMessageLike) {
    return isValidAssistantMessage(message);
  }

  function canForkMessage(message: PanelMessageLike, index: number) {
    if (!isValidAssistantMessage(message)) return false;
    if (!message.entryId) return false;
    return hasPreviousUserMessage(messages.value, index);
  }

  function canRetryMessage(message: PanelMessageLike, index: number) {
    if (!isValidAssistantMessage(message)) return false;
    if (!message.entryId) return false;
    if (!hasPreviousUserMessage(messages.value, index)) return false;
    return isLatestAssistantMessage(messages.value, index);
  }

  async function handleCopyMessage(payload: CopyPayload) {
    if (payload.role !== "assistant") return;
    const content = String(payload.content || "").trim();
    if (!content) return;

    try {
      await writeToClipboard(content);
      copiedEntryId.value = payload.entryId;
      clearCopiedStateTimer();
      copiedTimer = setTimeout(() => {
        copiedEntryId.value = "";
        copiedTimer = null;
      }, 1800);
      showActionNotice("success", "已复制");
    } catch {
      showActionNotice("error", "复制失败，请检查剪贴板权限");
    }
  }

  async function handleForkMessage(payload: ForkPayload) {
    if (!payload?.entryId || isRunning.value) return;

    const entryId = String(payload.entryId || "").trim();
    const targetIndex = findAssistantIndex(messages.value, entryId);
    const previousUserEntryId = targetIndex >= 0 ? findPreviousUserEntryId(messages.value, targetIndex) : "";
    if (targetIndex < 0 || !previousUserEntryId) return;

    try {
      forkingEntryId.value = entryId;
      pendingRegenerate.value = {
        mode: "fork",
        sourceEntryId: entryId,
        insertAfterUserEntryId: previousUserEntryId
      };
      await regenerateFromAssistantEntry(entryId, { mode: "fork" });
      showActionNotice("success", "已分叉到新对话");
    } catch (err) {
      forkingEntryId.value = "";
      pendingRegenerate.value = null;
      const message = err instanceof Error ? err.message : "分叉失败";
      showActionNotice("error", message);
    }
  }

  async function handleRetryMessage(payload: RetryPayload) {
    if (!payload?.entryId || isRunning.value) return;

    const entryId = String(payload.entryId || "").trim();
    const targetIndex = findAssistantIndex(messages.value, entryId);
    const previousUserEntryId = targetIndex >= 0 ? findPreviousUserEntryId(messages.value, targetIndex) : "";
    if (targetIndex < 0 || !previousUserEntryId) return;

    try {
      retryingEntryId.value = entryId;
      pendingRegenerate.value = {
        mode: "retry",
        sourceEntryId: entryId,
        insertAfterUserEntryId: previousUserEntryId
      };
      await regenerateFromAssistantEntry(entryId, { mode: "retry" });
      showActionNotice("success", "已发起重新回答");
    } catch (err) {
      retryingEntryId.value = "";
      pendingRegenerate.value = null;
      const message = err instanceof Error ? err.message : "重新回答失败";
      showActionNotice("error", message);
    }
  }

  function cleanupMessageActions() {
    clearCopiedStateTimer();
    clearNoticeTimer();
    retryingEntryId.value = "";
    forkingEntryId.value = "";
    pendingRegenerate.value = null;
  }

  return {
    copiedEntryId,
    retryingEntryId,
    forkingEntryId,
    pendingRegenerate,
    actionNotice,
    canCopyMessage,
    canForkMessage,
    canRetryMessage,
    handleCopyMessage,
    handleForkMessage,
    handleRetryMessage,
    cleanupMessageActions
  };
}
