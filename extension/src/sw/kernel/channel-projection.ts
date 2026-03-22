import { nowIso, randomId } from "./types";
import type {
  ChannelOutboxRecord,
  ChannelProjectionKind,
  ChannelProjectionOutcome,
  ChannelReplyProjection,
  ChannelTurnRecord,
} from "./channel-types";

export const WECHAT_REPLY_PART_MAX_CHARS = 1000;

function normalizeVisibleText(value: unknown): string {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function splitText(text: string, maxChars: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    out.push(text.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return out;
}

export function createProjectionOutcome(input: {
  channelTurnId: string;
  sessionId: string;
  trustTier?: "external_remote";
  assistantEntryId?: string;
  projectionKind: ChannelProjectionKind;
  visibleText: string;
}): ChannelProjectionOutcome {
  const visibleText = normalizeVisibleText(input.visibleText);
  return {
    channelTurnId: input.channelTurnId,
    sessionId: input.sessionId,
    assistantEntryId: input.assistantEntryId,
    projectionKind: input.projectionKind,
    visibleText,
    truncated: visibleText.length > WECHAT_REPLY_PART_MAX_CHARS,
    trustTier: input.trustTier || "external_remote",
  };
}

export function createWechatReplyProjection(
  outcome: ChannelProjectionOutcome,
  options: { deliveryId?: string; maxChars?: number } = {},
): ChannelReplyProjection {
  const deliveryId = String(options.deliveryId || "").trim() || randomId("delivery");
  const maxChars = Number.isInteger(options.maxChars) && Number(options.maxChars) > 0
    ? Number(options.maxChars)
    : WECHAT_REPLY_PART_MAX_CHARS;
  const parts = splitText(outcome.visibleText, maxChars).map((text) => ({
    kind: "text" as const,
    text,
  }));

  return {
    channelTurnId: outcome.channelTurnId,
    deliveryId,
    parts,
  };
}

export function createOutboxRecord(input: {
  turn: ChannelTurnRecord;
  outcome: ChannelProjectionOutcome;
  replyProjection: ChannelReplyProjection;
}): ChannelOutboxRecord {
  const at = nowIso();
  return {
    deliveryId: input.replyProjection.deliveryId,
    channelTurnId: input.turn.channelTurnId,
    sessionId: input.turn.sessionId,
    channelKind: input.turn.channelKind,
    projectionKind: input.outcome.projectionKind,
    deliveryStatus: "queued",
    attemptCount: 0,
    projection: input.outcome,
    replyProjection: input.replyProjection,
    createdAt: at,
    updatedAt: at,
  };
}
