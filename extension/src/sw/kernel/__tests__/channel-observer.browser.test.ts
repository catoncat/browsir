import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { attachChannelObserver } from "../channel-observer";
import { ChannelStore } from "../channel-store";
import {
  __resetIdbStorageForTest,
  clearIdbStores,
} from "../idb-storage";
import { HOST_PROTOCOL_VERSION } from "../host-protocol";
import { BrainOrchestrator } from "../orchestrator.browser";
import {
  buildChannelBindingKey,
  buildChannelConversationKey,
  buildRemoteMessageKey,
  type ChannelBindingRecord,
  type ChannelTurnRecord,
} from "../channel-types";

function createBinding(sessionId: string): ChannelBindingRecord {
  return {
    bindingKey: buildChannelBindingKey("wechat", "conv-1"),
    channelConversationKey: buildChannelConversationKey("wechat", "conv-1"),
    channelKind: "wechat",
    remoteConversationId: "conv-1",
    remoteUserId: "user-1",
    sessionId,
    trustTier: "external_remote",
    sourceLabel: "wechat",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
  };
}

function createRunningTurn(sessionId: string): ChannelTurnRecord {
  return {
    channelTurnId: "turn-1",
    bindingKey: buildChannelBindingKey("wechat", "conv-1"),
    remoteMessageKey: buildRemoteMessageKey("wechat", "conv-1", "msg-1"),
    channelKind: "wechat",
    remoteConversationId: "conv-1",
    remoteUserId: "user-1",
    remoteMessageId: "msg-1",
    sessionId,
    queuedMode: "start",
    lifecycleStatus: "running",
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

beforeEach(async () => {
  await __resetIdbStorageForTest();
  await clearIdbStores();
  (globalThis as any).chrome.runtime.getContexts = async () => [
    { contextType: "OFFSCREEN_DOCUMENT" },
  ];
  (globalThis as any).chrome.runtime.sendMessage = async (
    message: Record<string, unknown>,
  ) => {
    if (message.type === "host.command" && message.service === "wechat") {
      return {
        type: "host.response",
        protocolVersion: HOST_PROTOCOL_VERSION,
        id: String(message.id || ""),
        service: "wechat",
        action: String(message.action || ""),
        ok: true,
        data: {
          deliveryId: String(
            (message.payload as Record<string, unknown>)?.deliveryId || "",
          ),
          sentAt: "2026-03-22T00:00:01.000Z",
        },
      };
    }
    return { ok: true };
  };
});

describe("channel-observer", () => {
  it("creates queued outbox record when a running channel turn reaches loop_done", async () => {
    const orchestrator = new BrainOrchestrator();
    attachChannelObserver(orchestrator);
    const created = await orchestrator.createSession({
      metadata: {
        sourceLabel: "wechat",
        channel: {
          kind: "wechat",
          remoteConversationId: "conv-1",
          remoteUserId: "user-1",
        },
      },
    });

    const sessionId = created.sessionId;
    const store = new ChannelStore();
    await store.acceptInbound({
      binding: createBinding(sessionId),
      turn: createRunningTurn(sessionId),
      initialEvent: null,
    });
    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "final answer",
    });

    orchestrator.events.emit("loop_done", sessionId, {
      status: "done",
      llmSteps: 1,
      toolSteps: 0,
    });

    const deadline = Date.now() + 1000;
    let turn = await store.getTurn("turn-1");
    while (Date.now() < deadline && turn?.deliveryStatus !== "delivered") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      turn = await store.getTurn("turn-1");
    }

    expect(turn?.deliveryStatus).toBe("delivered");
    expect(turn?.assistantEntryId).toBeTruthy();

    const outbox = await store.listOutboxByTurn("turn-1");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.projection.visibleText).toBe("final answer");
    expect(outbox[0]?.projection.projectionKind).toBe("final_text");
    expect(outbox[0]?.deliveryStatus).toBe("delivered");
  });
});
