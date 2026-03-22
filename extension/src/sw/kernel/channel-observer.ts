import type { BrainOrchestrator } from "./orchestrator.browser";
import type { BrainEventEnvelope } from "./events";
import { randomId } from "./types";
import {
  createOutboxRecord,
  createProjectionOutcome,
  createWechatReplyProjection,
} from "./channel-projection";
import type { ChannelTurnRecord } from "./channel-types";

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
      const visibleText =
        latestAssistant.text ||
        (status === "done" ? "任务已完成。" : "请求未能完成。");
      const projectionKind =
        status === "done" ? "final_text" : "safe_failure";
      const projection = createProjectionOutcome({
        channelTurnId: turn.channelTurnId,
        sessionId: turn.sessionId,
        assistantEntryId: latestAssistant.entryId,
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
        assistantEntryId: latestAssistant.entryId,
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
          assistantEntryId: latestAssistant.entryId,
          terminalStatus: status,
        },
      });
    })().catch((error) => {
      console.warn("[channel-observer] failed", error);
    });
  });
}
