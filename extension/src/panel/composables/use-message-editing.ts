import { ref, type Ref } from "vue";
import type { PendingRegenerateState } from "../utils/message-actions";

export interface PanelMessageLike {
  role?: string;
  entryId?: string;
  content?: string;
}

export function useMessageEditing(deps: {
  messages: Ref<PanelMessageLike[]>;
  loading: Ref<boolean>;
  editUserMessageAndRerun: (
    entryId: string,
    content: string,
    opts: { setActive: boolean }
  ) => Promise<{ mode: "retry" | "fork"; sessionId: string; activeSourceEntryId?: string }>;
  switchForkSession: (id: string, opts: { startedAt?: number }) => Promise<void>;
  cancelForkScene: () => void;
  onError: (err: unknown, fallback: string) => void;
}) {
  const editingUserEntryId = ref("");
  const editingUserDraft = ref("");
  const editingUserSubmitting = ref(false);
  const userPendingRegenerate = ref<PendingRegenerateState | null>(null);
  const userForkingEntryId = ref("");

  function resetEditingState() {
    editingUserEntryId.value = "";
    editingUserDraft.value = "";
    editingUserSubmitting.value = false;
    userForkingEntryId.value = "";
  }

  function findLatestUserEntryId(items: PanelMessageLike[]) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const candidate = items[i];
      if (candidate?.role !== "user") continue;
      const entryId = String(candidate?.entryId || "").trim();
      if (!entryId) continue;
      if (!String(candidate?.content || "").trim()) continue;
      return entryId;
    }
    return "";
  }

  function canEditUserMessage(message: PanelMessageLike) {
    if (message?.role !== "user") return false;
    return String(message?.content || "").trim().length > 0;
  }

  async function handleEditMessage(payload: { entryId: string; content: string; role: string }) {
    if (payload?.role !== "user") return;
    if (deps.loading.value || editingUserSubmitting.value) return;
    const content = String(payload?.content || "").trim();
    if (!content) return;
    editingUserEntryId.value = String(payload?.entryId || "").trim();
    editingUserDraft.value = String(payload?.content || "");
  }

  function handleEditDraftChange(payload: { entryId: string; content: string }) {
    if (editingUserSubmitting.value) return;
    const entryId = String(payload?.entryId || "").trim();
    if (!entryId || editingUserEntryId.value !== entryId) return;
    editingUserDraft.value = String(payload?.content || "");
  }

  function handleEditCancel(payload: { entryId: string }) {
    if (editingUserSubmitting.value) return;
    const entryId = String(payload?.entryId || "").trim();
    if (!entryId || editingUserEntryId.value !== entryId) return;
    resetEditingState();
  }

  async function handleEditSubmit(payload: { entryId: string; content: string; role: string }) {
    if (payload?.role !== "user") return;
    if (deps.loading.value || editingUserSubmitting.value) return;
    const entryId = String(payload?.entryId || "").trim();
    if (!entryId || editingUserEntryId.value !== entryId) return;
    const content = String(payload?.content || "").trim();
    if (!content) return;

    const startedAt = Date.now();
    editingUserSubmitting.value = true;
    const latestUserEntryIdBeforeSubmit = findLatestUserEntryId(deps.messages.value);
    const predictedMode: "retry" | "fork" = latestUserEntryIdBeforeSubmit === entryId ? "retry" : "fork";
    if (predictedMode === "fork") {
      userForkingEntryId.value = entryId;
    }
    userPendingRegenerate.value = {
      mode: predictedMode,
      sourceEntryId: entryId,
      insertAfterUserEntryId: entryId,
      strategy: "insert",
    };
    try {
      const result = await deps.editUserMessageAndRerun(entryId, content, { setActive: false });
      const latestUserEntryId = findLatestUserEntryId(deps.messages.value);
      const sourceEntryId = String(result.activeSourceEntryId || entryId || "").trim();
      const anchorEntryId = latestUserEntryId || sourceEntryId;
      userPendingRegenerate.value = anchorEntryId
        ? {
            mode: result.mode,
            sourceEntryId,
            insertAfterUserEntryId: anchorEntryId,
            strategy: "insert",
          }
        : null;

      if (result.mode === "fork") {
        await deps.switchForkSession(result.sessionId, { startedAt });
      }

      resetEditingState();
    } catch (err) {
      userPendingRegenerate.value = null;
      deps.cancelForkScene();
      deps.onError(err, "编辑并重跑失败");
      console.error(err);
    } finally {
      editingUserSubmitting.value = false;
      if (!editingUserEntryId.value) {
        userForkingEntryId.value = "";
      }
    }
  }

  return {
    editingUserEntryId,
    editingUserDraft,
    editingUserSubmitting,
    userPendingRegenerate,
    userForkingEntryId,
    resetEditingState,
    findLatestUserEntryId,
    canEditUserMessage,
    handleEditMessage,
    handleEditDraftChange,
    handleEditCancel,
    handleEditSubmit,
  };
}
