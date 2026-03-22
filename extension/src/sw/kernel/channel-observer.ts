import type { BrainOrchestrator } from "./orchestrator.browser";
import { sendHostCommand } from "./channel-broker";
import type { BrainEventEnvelope } from "./events";
import { randomId } from "./types";
import {
  createOutboxRecord,
  createProjectionOutcome,
  createWechatReplyProjection,
} from "./channel-projection";
import type { ChannelTurnRecord } from "./channel-types";
import type { ChannelOutboxRecord } from "./channel-types";
import type { WechatReplySendInput, WechatReplySendResult } from "./host-protocol";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

async function readLatestAssistantText(
  orchestrator: BrainOrchestrator,
  sessionId: string,
): Promise<{ entryId?: string; text: string }> {
  const entries = await orchestrator.sessions.getEntries(sessionId);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    const text = String(entry.text || "").trim();
    if (!text) continue;
    return { entryId: entry.id, text };
  }
  return { text: "" };
}

async function findRunningTurn(
  orchestrator: BrainOrchestrator,
  sessionId: string,
): Promise<ChannelTurnRecord | null> {
  const turns = await orchestrator.channels.store.listTurnsBySession(sessionId);
  const running = turns
    .filter(
      (turn) =>
        turn.lifecycleStatus === "running" &&
        turn.deliveryStatus === "not_requested",
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return running[0] || null;
}

export function attachChannelObserver(orchestrator: BrainOrchestrator): void {
  orchestrator.events.subscribe((event: BrainEventEnvelope) => {
    void (async () => {
      if (event.type === "message.dequeued") {
        const payload = toRecord(event.payload);
        if (String(payload.behavior || "") !== "followUp") return;
        const queuedPromptId = String(payload.id || "").trim();
        if (!queuedPromptId) return;

        const turns = await orchestrator.channels.store.listTurnsBySession(
          event.sessionId,
        );
        const queued = turns
          .filter(
            (turn) =>
              turn.lifecycleStatus === "queued" &&
              turn.queuedPromptId === queuedPromptId,
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!queued) return;

        await orchestrator.channels.store.putTurn({
          ...queued,
          lifecycleStatus: "running",
          updatedAt: new Date().toISOString(),
        });
        await orchestrator.channels.store.appendEvent({
          eventId: randomId("channel_event"),
          channelTurnId: queued.channelTurnId,
          sessionId: queued.sessionId,
          type: "channel.turn.running",
          createdAt: new Date().toISOString(),
          payload: {
            queuedPromptId,
          },
        });
        return;
      }

      if (event.type !== "loop_done") return;

      const turn = await findRunningTurn(orchestrator, event.sessionId);
      if (!turn) return;

      const payload = toRecord(event.payload);
      const status = String(payload.status || "done").trim().toLowerCase();
      const latestAssistant = await readLatestAssistantText(
        orchestrator,
        event.sessionId,
      );
      const hasFreshAssistant =
        !!latestAssistant.entryId &&
        latestAssistant.entryId !== turn.assistantBaselineEntryId;
      const projectionKind =
        status === "done" && hasFreshAssistant
          ? "final_text"
          : "safe_failure";
      const visibleText =
        projectionKind === "final_text"
          ? latestAssistant.text
          : "本轮未生成新的可回复结果，请在插件中查看。";
      const projection = createProjectionOutcome({
        channelTurnId: turn.channelTurnId,
        sessionId: turn.sessionId,
        assistantEntryId: hasFreshAssistant ? latestAssistant.entryId : undefined,
        projectionKind,
        visibleText,
      });
      const replyProjection = createWechatReplyProjection(projection);
      const outbox = createOutboxRecord({
        turn,
        outcome: projection,
        replyProjection,
      });

      await orchestrator.channels.store.putOutbox(outbox);
      await orchestrator.channels.store.putTurn({
        ...turn,
          lifecycleStatus: status === "done" ? "projected" : "closed",
          deliveryStatus: "queued",
          assistantEntryId: hasFreshAssistant ? latestAssistant.entryId : undefined,
          deliveryId: outbox.deliveryId,
          updatedAt: new Date().toISOString(),
        });
      await orchestrator.channels.store.appendEvent({
        eventId: randomId("channel_event"),
        channelTurnId: turn.channelTurnId,
        sessionId: turn.sessionId,
        type: "channel.turn.projected",
        createdAt: new Date().toISOString(),
        payload: {
          projectionKind,
          deliveryId: outbox.deliveryId,
          assistantEntryId: hasFreshAssistant ? latestAssistant.entryId : undefined,
          terminalStatus: status,
        },
      });

      try {
        const sendInput: WechatReplySendInput = {
          deliveryId: outbox.deliveryId,
          channelTurnId: outbox.channelTurnId,
          sessionId: outbox.sessionId,
          userId: turn.remoteUserId,
          parts: outbox.replyProjection.parts,
        };
        const sendResult = await sendHostCommand<
          WechatReplySendInput,
          WechatReplySendResult
        >("wechat", "reply.text", sendInput);

        const deliveredOutbox: ChannelOutboxRecord = {
          ...outbox,
          deliveryStatus: "delivered",
          attemptCount: outbox.attemptCount + 1,
          updatedAt: sendResult.sentAt,
        };
        await orchestrator.channels.store.putOutbox(deliveredOutbox);
        await orchestrator.channels.store.putTurn({
          ...turn,
          lifecycleStatus: "delivered",
          deliveryStatus: "delivered",
          assistantEntryId: hasFreshAssistant ? latestAssistant.entryId : undefined,
          deliveryId: outbox.deliveryId,
          updatedAt: sendResult.sentAt,
        });
        await orchestrator.channels.store.appendEvent({
          eventId: randomId("channel_event"),
          channelTurnId: turn.channelTurnId,
          sessionId: turn.sessionId,
          type: "channel.turn.delivered",
          createdAt: sendResult.sentAt,
          payload: {
            deliveryId: outbox.deliveryId,
          },
        });
      } catch (error) {
        const uncertainAt = new Date().toISOString();
        await orchestrator.channels.store.putOutbox({
          ...outbox,
          deliveryStatus: "uncertain",
          attemptCount: outbox.attemptCount + 1,
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: uncertainAt,
        });
        await orchestrator.channels.store.putTurn({
          ...turn,
          lifecycleStatus: "sending",
          deliveryStatus: "uncertain",
          assistantEntryId: hasFreshAssistant ? latestAssistant.entryId : undefined,
          deliveryId: outbox.deliveryId,
          updatedAt: uncertainAt,
        });
        await orchestrator.channels.store.appendEvent({
          eventId: randomId("channel_event"),
          channelTurnId: turn.channelTurnId,
          sessionId: turn.sessionId,
          type: "channel.turn.delivery_uncertain",
          createdAt: uncertainAt,
          payload: {
            deliveryId: outbox.deliveryId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })().catch((error) => {
      console.warn("[channel-observer] failed", error);
    });
  });
}
