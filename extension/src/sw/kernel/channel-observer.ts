import type { BrainOrchestrator } from "./orchestrator.browser";
import { sendHostCommand } from "./channel-broker";
import type { BrainEventEnvelope } from "./events";
import { randomId } from "./types";
import {
  createOutboxRecord,
  createProjectionOutcome,
  createWechatReplyProjection,
} from "./channel-projection";
import { normalizeHostedAssistantIdentity } from "../../shared/cursor-help-web-shared";
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

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLatestAssistantTextFromStepStream(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  notBeforeIso: string,
): Promise<string> {
  try {
    await orchestrator.flushSessionTraceWrites(sessionId);
  } catch (error) {
    console.warn("[channel-observer] flushSessionTraceWrites failed", error);
  }
  const threshold = Date.parse(notBeforeIso);
  const stream = await orchestrator.getStepStream(sessionId);
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const item = stream[i];
    const ts = Date.parse(String(item.timestamp || ""));
    if (Number.isFinite(threshold) && Number.isFinite(ts) && ts < threshold) {
      continue;
    }
    const itemType = String(item.type || "").trim();
    const payload = toRecord(item.payload);

    if (itemType === "hosted_chat.turn_resolved") {
      const result = toRecord(payload.result);
      const text = String(result.assistantText || "").trim();
      if (text) {
        const entries = await orchestrator.sessions.getEntries(sessionId);
        const latestUserText = Array.from(entries)
          .reverse()
          .find(
            (entry) =>
              entry.type === "message" &&
              entry.role === "user" &&
              String(entry.text || "").trim(),
          )?.text;
        return normalizeHostedAssistantIdentity(latestUserText, text).trim();
      }
      continue;
    }

    if (itemType === "step_finished") {
      const ok = payload.ok === true;
      const mode = String(payload.mode || "").trim();
      const preview = String(payload.preview || "").trim();
      if (ok && mode === "llm" && preview) {
        return preview;
      }
    }
  }
  return "";
}

async function resolveFreshAssistantResult(
  orchestrator: BrainOrchestrator,
  turn: ChannelTurnRecord,
): Promise<{ assistantEntryId?: string; text: string }> {
  const maxAttempts = 5;
  const waitPerAttemptMs = 40;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const latestAssistant = await readLatestAssistantText(
      orchestrator,
      turn.sessionId,
    );
    const hasFreshAssistantEntry =
      !!latestAssistant.entryId &&
      latestAssistant.entryId !== turn.assistantBaselineEntryId;
    if (hasFreshAssistantEntry) {
      return {
        assistantEntryId: latestAssistant.entryId,
        text: latestAssistant.text,
      };
    }

    const fallbackAssistantText = await readLatestAssistantTextFromStepStream(
      orchestrator,
      turn.sessionId,
      turn.createdAt,
    );
    if (fallbackAssistantText) {
      return {
        assistantEntryId: latestAssistant.entryId,
        text: fallbackAssistantText,
      };
    }

    if (attempt < maxAttempts - 1) {
      await waitMs(waitPerAttemptMs);
    }
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
      const freshAssistant = await resolveFreshAssistantResult(
        orchestrator,
        turn,
      );
      const hasFreshAssistant = !!freshAssistant.text;
      const resolvedAssistantText = freshAssistant.text;
      const projectionKind = hasFreshAssistant ? "final_text" : "safe_failure";
      const visibleText =
        projectionKind === "final_text"
          ? resolvedAssistantText
          : "本轮未生成新的可回复结果，请在插件中查看。";
      const projection = createProjectionOutcome({
        channelTurnId: turn.channelTurnId,
        sessionId: turn.sessionId,
        assistantEntryId: hasFreshAssistant ? freshAssistant.assistantEntryId : undefined,
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
          lifecycleStatus: projectionKind === "final_text" ? "projected" : "closed",
          deliveryStatus: "queued",
          assistantEntryId: hasFreshAssistant ? freshAssistant.assistantEntryId : undefined,
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
          assistantEntryId: hasFreshAssistant ? freshAssistant.assistantEntryId : undefined,
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
          assistantEntryId: hasFreshAssistant ? freshAssistant.assistantEntryId : undefined,
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
          assistantEntryId: hasFreshAssistant ? freshAssistant.assistantEntryId : undefined,
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
