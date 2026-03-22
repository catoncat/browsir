import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  WECHAT_REPLY_PART_MAX_CHARS,
  createOutboxRecord,
  createProjectionOutcome,
  createWechatReplyProjection,
} from "../channel-projection";
import type { ChannelTurnRecord } from "../channel-types";

function createTurn(): ChannelTurnRecord {
  return {
    channelTurnId: "turn-1",
    bindingKey: "wechat:conv-1",
    remoteMessageKey: "wechat:conv-1:msg-1",
    channelKind: "wechat",
    remoteConversationId: "conv-1",
    remoteUserId: "user-1",
    remoteMessageId: "msg-1",
    sessionId: "session-1",
    queuedMode: "start",
    lifecycleStatus: "projected",
    dispatchStatus: "queued",
    deliveryStatus: "not_requested",
    interventionStatus: "none",
    repairStatus: "none",
    anomalyFlags: [],
    runAttemptCount: 1,
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
  };
}

describe("channel-projection", () => {
  it("creates terminal projection outcomes for final text", () => {
    const outcome = createProjectionOutcome({
      channelTurnId: "turn-1",
      sessionId: "session-1",
      assistantEntryId: "assistant-1",
      projectionKind: "final_text",
      visibleText: "final answer",
    });

    expect(outcome).toEqual({
      channelTurnId: "turn-1",
      sessionId: "session-1",
      assistantEntryId: "assistant-1",
      projectionKind: "final_text",
      visibleText: "final answer",
      truncated: false,
      trustTier: "external_remote",
    });
  });

  it("splits long WeChat reply text into bounded parts", () => {
    const outcome = createProjectionOutcome({
      channelTurnId: "turn-1",
      sessionId: "session-1",
      projectionKind: "safe_failure",
      visibleText: "x".repeat(WECHAT_REPLY_PART_MAX_CHARS + 25),
    });

    const reply = createWechatReplyProjection(outcome, {
      deliveryId: "delivery-1",
    });

    expect(outcome.truncated).toBe(true);
    expect(reply.deliveryId).toBe("delivery-1");
    expect(reply.parts).toHaveLength(2);
    expect(reply.parts[0].text).toHaveLength(WECHAT_REPLY_PART_MAX_CHARS);
    expect(reply.parts[1].text).toHaveLength(25);
  });

  it("creates queued outbox records from a turn and projection", () => {
    const turn = createTurn();
    const outcome = createProjectionOutcome({
      channelTurnId: turn.channelTurnId,
      sessionId: turn.sessionId,
      projectionKind: "error",
      visibleText: "error happened",
    });
    const reply = createWechatReplyProjection(outcome, {
      deliveryId: "delivery-1",
    });

    const record = createOutboxRecord({
      turn,
      outcome,
      replyProjection: reply,
    });

    expect(record.deliveryId).toBe("delivery-1");
    expect(record.deliveryStatus).toBe("queued");
    expect(record.projection.visibleText).toBe("error happened");
    expect(record.replyProjection.parts[0].text).toBe("error happened");
  });
});
