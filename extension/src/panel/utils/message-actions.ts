import { computed, ref, type Ref } from "vue";

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

export interface RegeneratePayload {
  entryId: string;
}

export interface ActionNotice {
  type: "success" | "error";
  message: string;
}

interface UseMessageActionsOptions {
  messages: Ref<PanelMessageLike[]>;
  isRunning: Ref<boolean>;
  regenerateFromAssistantEntry: (entryId: string) => Promise<void>;
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
  const actionNotice = ref<ActionNotice | null>(null);

  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const latestRegenerableAssistantEntryId = computed(() => {
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const candidate = messages.value[i];
      if (!isValidAssistantMessage(candidate)) continue;
      if (!hasPreviousUserMessage(messages.value, i)) continue;
      return String(candidate.entryId || "");
    }
    return "";
  });

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

  function canRegenerateMessage(message: PanelMessageLike, index: number) {
    if (!isValidAssistantMessage(message)) return false;
    if (!message.entryId) return false;
    if (message.entryId !== latestRegenerableAssistantEntryId.value) return false;
    return hasPreviousUserMessage(messages.value, index);
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

  async function handleRegenerateMessage(payload: RegeneratePayload) {
    if (!payload?.entryId || isRunning.value) return;

    try {
      await regenerateFromAssistantEntry(payload.entryId);
      showActionNotice("success", "已发起重新回答");
    } catch (err) {
      const message = err instanceof Error ? err.message : "重新回答失败";
      showActionNotice("error", message);
    }
  }

  function cleanupMessageActions() {
    clearCopiedStateTimer();
    clearNoticeTimer();
  }

  return {
    copiedEntryId,
    actionNotice,
    canCopyMessage,
    canRegenerateMessage,
    handleCopyMessage,
    handleRegenerateMessage,
    cleanupMessageActions
  };
}
