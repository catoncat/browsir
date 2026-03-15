export const PREFERRED_SLOT_ID_BY_SESSION = new Map<string, string>();
export const PREFERRED_SLOT_ID_BY_CONVERSATION = new Map<string, string>();
export const LAST_CONVERSATION_KEY_BY_SESSION = new Map<string, string>();

export function clearSlotPreferences(slotId: string): void {
  const normalizedSlotId = String(slotId || "").trim();
  if (!normalizedSlotId) return;
  const removedConversationKeys = new Set<string>();
  for (const [sessionId, preferredSlotId] of PREFERRED_SLOT_ID_BY_SESSION) {
    if (preferredSlotId === normalizedSlotId) {
      PREFERRED_SLOT_ID_BY_SESSION.delete(sessionId);
    }
  }
  for (const [conversationKey, preferredSlotId] of PREFERRED_SLOT_ID_BY_CONVERSATION) {
    if (preferredSlotId === normalizedSlotId) {
      removedConversationKeys.add(conversationKey);
      PREFERRED_SLOT_ID_BY_CONVERSATION.delete(conversationKey);
    }
  }
  for (const [sessionId, conversationKey] of LAST_CONVERSATION_KEY_BY_SESSION) {
    if (removedConversationKeys.has(conversationKey)) {
      LAST_CONVERSATION_KEY_BY_SESSION.delete(sessionId);
    }
  }
}

export function clearSessionPreferences(sessionId: string): void {
  const conversationKey = LAST_CONVERSATION_KEY_BY_SESSION.get(sessionId);
  if (conversationKey) {
    PREFERRED_SLOT_ID_BY_CONVERSATION.delete(conversationKey);
    LAST_CONVERSATION_KEY_BY_SESSION.delete(sessionId);
  }
  PREFERRED_SLOT_ID_BY_SESSION.delete(sessionId);
}

export function hasSlotAffinity(slotId: string): boolean {
  for (const preferredSlotId of PREFERRED_SLOT_ID_BY_SESSION.values()) {
    if (preferredSlotId === slotId) return true;
  }
  for (const preferredSlotId of PREFERRED_SLOT_ID_BY_CONVERSATION.values()) {
    if (preferredSlotId === slotId) return true;
  }
  return false;
}
