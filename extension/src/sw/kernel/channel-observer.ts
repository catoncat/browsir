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

const DELIVERY_MAX_ATTEMPTS = 3;
const DELIVERY_RETRY_DELAYS_MS = [100, 300] as const;
const sessionObserverQueues = new Map<string, Promise<void>>();

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminalDeliveryError(error: unknown): boolean {
  const text = toErrorMessage(error).toLowerCase();
  return (
    text.includes("通道未启用") ||
    text.includes("未登录") ||
    text.includes("context_token") ||
    text.includes("缺少用户")
  );
}

async function runSessionObserverTask(
  sessionId: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = sessionObserverQueues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  sessionObserverQueues.set(sessionId, tail);
  await previous.catch(() => {});
  try {
    await task();
  } finally {
    release();
    if (sessionObserverQueues.get(sessionId) === tail) {
      sessionObserverQueues.delete(sessionId);
    }
  }
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

async function deliverWechatOutbox(
  orchestrator: BrainOrchestrator,
  turn: ChannelTurnRecord,
  outbox: ChannelOutboxRecord,
): Promise<void> {
  let currentTurn: ChannelTurnRecord = {
    ...turn,
    lifecycleStatus: "sending",
    deliveryStatus: "sending",
    updatedAt: new Date().toISOString(),
  };
  let currentOutbox: ChannelOutboxRecord = {
    ...outbox,
    deliveryStatus: "sending",
    updatedAt: currentTurn.updatedAt,
  };
  await orchestrator.channels.store.putOutbox(currentOutbox);
  await orchestrator.channels.store.putTurn(currentTurn);

  for (let attempt = currentOutbox.attemptCount + 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt += 1) {
    const alreadyDelivered = Math.max(0, Number(currentOutbox.deliveredPartCount || 0));
    const remainingParts = currentOutbox.replyProjection.parts.slice(alreadyDelivered);
    if (!remainingParts.length) {
      const deliveredAt = String(currentOutbox.updatedAt || "").trim() || new Date().toISOString();
      currentOutbox = {
        ...currentOutbox,
        deliveryStatus: "delivered",
        updatedAt: deliveredAt,
      };
      currentTurn = {
        ...currentTurn,
        lifecycleStatus: "delivered",
        deliveryStatus: "delivered",
        updatedAt: deliveredAt,
      };
      await orchestrator.channels.store.putOutbox(currentOutbox);
      await orchestrator.channels.store.putTurn(currentTurn);
      await orchestrator.channels.store.appendEvent({
        eventId: randomId("channel_event"),
        channelTurnId: currentTurn.channelTurnId,
        sessionId: currentTurn.sessionId,
        type: "channel.turn.delivered",
        createdAt: deliveredAt,
        payload: {
          deliveryId: currentOutbox.deliveryId,
          deliveredPartCount: alreadyDelivered,
        },
      });
      return;
    }

    let result: WechatReplySendResult | null = null;
    let errorMessage = "";
    try {
      const sendInput: WechatReplySendInput = {
        deliveryId: currentOutbox.deliveryId,
        channelTurnId: currentOutbox.channelTurnId,
        sessionId: currentOutbox.sessionId,
        userId: currentTurn.remoteUserId,
        parts: remainingParts,
      };
      result = await sendHostCommand<WechatReplySendInput, WechatReplySendResult>(
        "wechat",
        "reply.text",
        sendInput,
      );
    } catch (error) {
      errorMessage = toErrorMessage(error);
    }

    const sentAt = String(result?.sentAt || "").trim() || new Date().toISOString();
    const deliveredThisAttempt = Math.max(
      0,
      Math.min(
        Number(result?.deliveredPartCount || 0),
        remainingParts.length,
      ),
    );
    const deliveredPartCount = Math.min(
      currentOutbox.replyProjection.parts.length,
      alreadyDelivered + deliveredThisAttempt,
    );
    const lastError = errorMessage || String(result?.lastError || "").trim();
    currentOutbox = {
      ...currentOutbox,
      attemptCount: attempt,
      deliveredPartCount,
      updatedAt: sentAt,
      ...(lastError ? { lastError } : {}),
    };

    const complete =
      result?.complete === true &&
      deliveredPartCount >= currentOutbox.replyProjection.parts.length;
    if (complete) {
      currentOutbox = {
        ...currentOutbox,
        deliveryStatus: "delivered",
        updatedAt: sentAt,
      };
      currentTurn = {
        ...currentTurn,
        lifecycleStatus: "delivered",
        deliveryStatus: "delivered",
        updatedAt: sentAt,
      };
      await orchestrator.channels.store.putOutbox(currentOutbox);
      await orchestrator.channels.store.putTurn(currentTurn);
      await orchestrator.channels.store.appendEvent({
        eventId: randomId("channel_event"),
        channelTurnId: currentTurn.channelTurnId,
        sessionId: currentTurn.sessionId,
        type: "channel.turn.delivered",
        createdAt: sentAt,
        payload: {
          deliveryId: currentOutbox.deliveryId,
          deliveredPartCount,
        },
      });
      return;
    }

    const terminal = lastError ? isTerminalDeliveryError(lastError) : false;
    const hasAttemptsLeft =
      !terminal && attempt < DELIVERY_MAX_ATTEMPTS;
    if (hasAttemptsLeft) {
      await orchestrator.channels.store.putOutbox(currentOutbox);
      await orchestrator.channels.store.appendEvent({
        eventId: randomId("channel_event"),
        channelTurnId: currentTurn.channelTurnId,
        sessionId: currentTurn.sessionId,
        type: "channel.turn.delivery_retry_scheduled",
        createdAt: sentAt,
        payload: {
          deliveryId: currentOutbox.deliveryId,
          attempt,
          deliveredPartCount,
          remainingPartCount:
            currentOutbox.replyProjection.parts.length - deliveredPartCount,
          ...(lastError ? { error: lastError } : {}),
        },
      });
      await waitMs(
        DELIVERY_RETRY_DELAYS_MS[
          Math.min(attempt - 1, DELIVERY_RETRY_DELAYS_MS.length - 1)
        ] || DELIVERY_RETRY_DELAYS_MS[DELIVERY_RETRY_DELAYS_MS.length - 1],
      );
      continue;
    }

    currentOutbox = {
      ...currentOutbox,
      deliveryStatus: "dead_letter",
      updatedAt: sentAt,
      lastError: lastError || "WeChat delivery exhausted retry budget",
    };
    currentTurn = {
      ...currentTurn,
      lifecycleStatus: "closed",
      deliveryStatus: "dead_letter",
      updatedAt: sentAt,
    };
    await orchestrator.channels.store.putOutbox(currentOutbox);
    await orchestrator.channels.store.putTurn(currentTurn);
    await orchestrator.channels.store.appendEvent({
      eventId: randomId("channel_event"),
      channelTurnId: currentTurn.channelTurnId,
      sessionId: currentTurn.sessionId,
      type: "channel.turn.dead_lettered",
      createdAt: sentAt,
      payload: {
        deliveryId: currentOutbox.deliveryId,
        deliveredPartCount,
        error: currentOutbox.lastError,
      },
    });
    return;
  }
}

export function attachChannelObserver(orchestrator: BrainOrchestrator): void {
  orchestrator.events.subscribe((event: BrainEventEnvelope) => {
    const sessionId = String(event.sessionId || "").trim();
    const work = async () => {
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
      const projectedTurn: ChannelTurnRecord = {
          ...turn,
          lifecycleStatus: projectionKind === "final_text" ? "projected" : "closed",
          deliveryStatus: "queued",
          assistantEntryId: hasFreshAssistant ? freshAssistant.assistantEntryId : undefined,
          deliveryId: outbox.deliveryId,
          updatedAt: new Date().toISOString(),
        };
      await orchestrator.channels.store.putTurn(projectedTurn);
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
      await deliverWechatOutbox(orchestrator, projectedTurn, outbox);
    };
    const runner = sessionId
      ? runSessionObserverTask(sessionId, work)
      : work();
    void runner.catch((error) => {
      console.warn("[channel-observer] failed", error);
    });
  });
}
