import type { RuntimeLoopController } from "../runtime-loop.browser";
import type { BrainOrchestrator } from "../orchestrator.browser";
import { nowIso, randomId } from "../types";
import { sendHostCommand } from "../channel-broker";
import type { WechatHostStateSnapshot } from "../host-protocol";
import type {
  ChannelBindingRecord,
  ChannelEventRecord,
  ChannelTurnRecord,
} from "../channel-types";
import {
  buildChannelBindingKey,
  buildChannelConversationKey,
  buildRemoteMessageKey,
} from "../channel-types";

type RuntimeOk<T = unknown> = { ok: true; data: T };
type RuntimeErr = { ok: false; error: string };
type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

function ok<T>(data: T): RuntimeOk<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeErr {
  return { ok: false, error };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readRequiredText(payload: Record<string, unknown>, key: string): string {
  const value = String(payload[key] || "").trim();
  if (!value) {
    throw new Error(`${key} 不能为空`);
  }
  return value;
}

function buildChannelMetadata(binding: ChannelBindingRecord, channelTurnId: string) {
  return {
    source: "remote_channel",
    sourceLabel: "wechat",
    channel: {
      kind: binding.channelKind,
      remoteConversationId: binding.remoteConversationId,
      remoteUserId: binding.remoteUserId,
    },
    channelTurnId,
  } satisfies Record<string, unknown>;
}

async function upsertBinding(
  orchestrator: BrainOrchestrator,
  payload: Record<string, unknown>,
): Promise<ChannelBindingRecord> {
  const channelKind = "wechat" as const;
  const remoteConversationId = readRequiredText(payload, "remoteConversationId");
  const remoteUserId = readRequiredText(payload, "remoteUserId");
  const bindingKey = buildChannelBindingKey(channelKind, remoteConversationId);
  const existing = await orchestrator.channels.store.getBinding(
    channelKind,
    remoteConversationId,
  );
  if (existing) return existing;

  const created = await orchestrator.createSession({
    metadata: {
      channel: {
        kind: channelKind,
        remoteConversationId,
        remoteUserId,
      },
      sourceLabel: "wechat",
    },
  });

  return {
    bindingKey,
    channelConversationKey: buildChannelConversationKey(
      channelKind,
      remoteConversationId,
    ),
    channelKind,
    remoteConversationId,
    remoteUserId,
    sessionId: created.sessionId,
    trustTier: "external_remote",
    sourceLabel: "wechat",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function createTurn(
  binding: ChannelBindingRecord,
  payload: Record<string, unknown>,
): ChannelTurnRecord {
  const remoteMessageId = readRequiredText(payload, "remoteMessageId");
  return {
    channelTurnId: randomId("channel_turn"),
    bindingKey: binding.bindingKey,
    remoteMessageKey: buildRemoteMessageKey(
      binding.channelKind,
      binding.remoteConversationId,
      remoteMessageId,
    ),
    channelKind: binding.channelKind,
    remoteConversationId: binding.remoteConversationId,
    remoteUserId: binding.remoteUserId,
    remoteMessageId,
    sessionId: binding.sessionId,
    queuedMode: "start",
    lifecycleStatus: "received",
    dispatchStatus: "pending",
    deliveryStatus: "not_requested",
    interventionStatus: "none",
    repairStatus: "none",
    anomalyFlags: [],
    runAttemptCount: 0,
    sourceLabel: binding.sourceLabel,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function createAcceptedEvent(turn: ChannelTurnRecord): ChannelEventRecord {
  return {
    eventId: randomId("channel_event"),
    channelTurnId: turn.channelTurnId,
    sessionId: turn.sessionId,
    type: "channel.turn.accepted",
    createdAt: nowIso(),
    payload: {
      lifecycleStatus: turn.lifecycleStatus,
      dispatchStatus: turn.dispatchStatus,
    },
  };
}

export async function handleBrainChannelWechat(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  try {
    if (action === "brain.channel.wechat.get_state") {
      return ok(
        await sendHostCommand<Record<string, unknown>, WechatHostStateSnapshot>(
          "wechat",
          "get_state",
          {},
        ),
      );
    }

    if (action === "brain.channel.wechat.login.start") {
      return ok(
        await sendHostCommand<Record<string, unknown>, WechatHostStateSnapshot>(
          "wechat",
          "login.start",
          {},
        ),
      );
    }

    if (action === "brain.channel.wechat.logout") {
      return ok(
        await sendHostCommand<Record<string, unknown>, WechatHostStateSnapshot>(
          "wechat",
          "logout",
          {},
        ),
      );
    }

    if (action === "brain.channel.wechat.inbound") {
      const remoteConversationId = readRequiredText(
        payload,
        "remoteConversationId",
      );
      const remoteMessageId = readRequiredText(payload, "remoteMessageId");
      const text = readRequiredText(payload, "text");

      const duplicate = await orchestrator.channels.store.getTurnByRemoteMessage(
        "wechat",
        remoteConversationId,
        remoteMessageId,
      );
      if (duplicate) {
        return ok({
          status: "duplicate",
          channelTurnId: duplicate.channelTurnId,
          sessionId: duplicate.sessionId,
        });
      }

      const binding = await upsertBinding(orchestrator, payload);
      const turn = createTurn(binding, payload);
      await orchestrator.channels.store.acceptInbound({
        binding,
        turn,
        initialEvent: createAcceptedEvent(turn),
      });

      const currentRuntime = orchestrator.getRunState(binding.sessionId);
      if (currentRuntime.running) {
        await orchestrator.appendUserMessage(binding.sessionId, text, {
          metadata: buildChannelMetadata(binding, turn.channelTurnId),
        });
        const queuedRuntime = orchestrator.enqueueQueuedPrompt(
          binding.sessionId,
          "followUp",
          text,
        );
        const queuedPrompt = [...queuedRuntime.queue.items]
          .filter((item) => item.behavior === "followUp")
          .at(-1);
        await orchestrator.channels.store.putTurn({
          ...turn,
          queuedMode: "followUp",
          lifecycleStatus: "queued",
          dispatchStatus: "queued",
          queuedPromptId: String(queuedPrompt?.id || "").trim() || undefined,
          updatedAt: nowIso(),
        });
        await orchestrator.channels.store.appendEvent({
          eventId: randomId("channel_event"),
          channelTurnId: turn.channelTurnId,
          sessionId: turn.sessionId,
          type: "channel.turn.follow_up_queued",
          createdAt: nowIso(),
          payload: {
            queuedPromptId: String(queuedPrompt?.id || "").trim() || undefined,
            queueTotal: queuedRuntime.queue.total,
          },
        });
        return ok({
          status: "accepted",
          sessionId: binding.sessionId,
          channelTurnId: turn.channelTurnId,
          queuedMode: "followUp",
        });
      }

      const runtime = await runtimeLoop.startFromPrompt({
        sessionId: binding.sessionId,
        prompt: text,
        autoRun: true,
      });
      await orchestrator.channels.store.putTurn({
        ...turn,
        lifecycleStatus: "running",
        dispatchStatus: "queued",
        runAttemptCount: 1,
        updatedAt: nowIso(),
      });
      await orchestrator.channels.store.appendEvent({
        eventId: randomId("channel_event"),
        channelTurnId: turn.channelTurnId,
        sessionId: turn.sessionId,
        type: "channel.turn.dispatched",
        createdAt: nowIso(),
        payload: {
          queuedMode: "start",
          running: runtime.runtime.running,
        },
      });
      await orchestrator.sessions.updateMeta(binding.sessionId, (meta) => ({
        ...meta,
        header: {
          ...meta.header,
          metadata: {
            ...(meta.header.metadata || {}),
            channel: {
              kind: binding.channelKind,
              remoteConversationId: binding.remoteConversationId,
              remoteUserId: binding.remoteUserId,
            },
            sourceLabel: binding.sourceLabel,
          },
        },
      }));
      return ok({
        status: "accepted",
        sessionId: binding.sessionId,
        channelTurnId: turn.channelTurnId,
        queuedMode: "start",
      });
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  return fail(`unsupported wechat action: ${action}`);
}
