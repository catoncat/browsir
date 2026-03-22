import type { JsonRecord } from "./types";

export type ChannelKind = "wechat";
export type ChannelTrustTier = "external_remote";
export type ChannelQueuedMode = "start" | "followUp";

export type ChannelLifecycleStatus =
  | "received"
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "projected"
  | "sending"
  | "delivered"
  | "closed";

export type ChannelDispatchStatus =
  | "idle"
  | "pending"
  | "queued"
  | "uncertain"
  | "skipped_duplicate";

export type ChannelDeliveryStatus =
  | "not_requested"
  | "queued"
  | "sending"
  | "uncertain"
  | "delivered"
  | "dead_letter";

export type ChannelInterventionStatus =
  | "none"
  | "pending"
  | "approved"
  | "cancelled"
  | "expired";

export type ChannelRepairStatus =
  | "none"
  | "pending"
  | "in_progress"
  | "resolved"
  | "exhausted";

export type ChannelProjectionKind =
  | "final_text"
  | "bounded_summary"
  | "intervention_cancelled"
  | "intervention_expired"
  | "safe_failure"
  | "denied"
  | "error";

export interface ChannelBindingRecord {
  bindingKey: string;
  channelConversationKey: string;
  channelKind: ChannelKind;
  remoteConversationId: string;
  remoteUserId: string;
  sessionId: string;
  trustTier: ChannelTrustTier;
  sourceLabel?: string;
  metadata?: JsonRecord;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelTurnRecord {
  channelTurnId: string;
  bindingKey: string;
  remoteMessageKey: string;
  channelKind: ChannelKind;
  remoteConversationId: string;
  remoteUserId: string;
  remoteMessageId: string;
  sessionId: string;
  queuedMode: ChannelQueuedMode;
  lifecycleStatus: ChannelLifecycleStatus;
  dispatchStatus: ChannelDispatchStatus;
  deliveryStatus: ChannelDeliveryStatus;
  interventionStatus: ChannelInterventionStatus;
  repairStatus: ChannelRepairStatus;
  anomalyFlags: string[];
  runAttemptCount: number;
  queuedPromptId?: string;
  currentRunId?: string;
  assistantEntryId?: string;
  deliveryId?: string;
  sourceLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelProjectionOutcome {
  channelTurnId: string;
  sessionId: string;
  assistantEntryId?: string;
  projectionKind: ChannelProjectionKind;
  visibleText: string;
  truncated: boolean;
  trustTier: ChannelTrustTier;
}

export interface ChannelReplyProjection {
  channelTurnId: string;
  deliveryId: string;
  parts: Array<{ kind: "text"; text: string }>;
}

export interface ChannelOutboxRecord {
  deliveryId: string;
  channelTurnId: string;
  sessionId: string;
  channelKind: ChannelKind;
  projectionKind: ChannelProjectionKind;
  deliveryStatus: ChannelDeliveryStatus;
  attemptCount: number;
  projection: ChannelProjectionOutcome;
  replyProjection: ChannelReplyProjection;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelEventRecord {
  eventId: string;
  channelTurnId: string;
  sessionId: string;
  type: string;
  createdAt: string;
  payload: JsonRecord;
}

export function buildChannelConversationKey(
  channelKind: ChannelKind,
  remoteConversationId: string,
): string {
  return `${channelKind}:${String(remoteConversationId || "").trim()}`;
}

export function buildChannelBindingKey(
  channelKind: ChannelKind,
  remoteConversationId: string,
): string {
  return buildChannelConversationKey(channelKind, remoteConversationId);
}

export function buildRemoteMessageKey(
  channelKind: ChannelKind,
  remoteConversationId: string,
  remoteMessageId: string,
): string {
  return `${buildChannelConversationKey(channelKind, remoteConversationId)}:${String(
    remoteMessageId || "",
  ).trim()}`;
}
