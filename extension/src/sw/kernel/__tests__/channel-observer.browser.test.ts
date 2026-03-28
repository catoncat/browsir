import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { WECHAT_REPLY_PART_MAX_CHARS } from "../channel-projection";

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
          deliveredPartCount: Array.isArray(
            (message.payload as Record<string, unknown>)?.parts,
          )
            ? (
              (message.payload as Record<string, unknown>)?.parts as unknown[]
            ).length
            : 0,
          complete: true,
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

  it("flushes pending trace writes before falling back to hosted_chat.turn_resolved assistantText", async () => {
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
    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "old answer",
    });
    const baselineEntry = (await orchestrator.sessions.getEntries(sessionId)).at(-1);
    await store.acceptInbound({
      binding: createBinding(sessionId),
      turn: {
        ...createRunningTurn(sessionId),
        assistantBaselineEntryId: String(baselineEntry?.id || ""),
      },
      initialEvent: null,
    });

    orchestrator.events.emit("hosted_chat.turn_resolved", sessionId, {
      result: {
        assistantText: "fresh stream answer",
        toolCalls: [],
        finishReason: "stop",
      },
    });
    orchestrator.events.emit("loop_done", sessionId, {
      status: "done",
      llmSteps: 1,
      toolSteps: 0,
    });

    const deadline = Date.now() + 1000;
    let outbox = await store.listOutboxByTurn("turn-1");
    while (Date.now() < deadline && outbox[0]?.deliveryStatus !== "delivered") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      outbox = await store.listOutboxByTurn("turn-1");
    }

    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.projection.visibleText).toBe("fresh stream answer");
    expect(outbox[0]?.projection.projectionKind).toBe("final_text");
  });

  it("serializes repeated loop_done events so one turn is delivered once", async () => {
    const sendMessageMock = vi.fn(
      async (message: Record<string, unknown>) => {
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
              deliveredPartCount: Array.isArray(
                (message.payload as Record<string, unknown>)?.parts,
              )
                ? (
                  (message.payload as Record<string, unknown>)?.parts as unknown[]
                ).length
                : 0,
              complete: true,
            },
          };
        }
        return { ok: true };
      },
    );
    (globalThis as any).chrome.runtime.sendMessage = sendMessageMock;

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
      text: "deliver once",
    });

    orchestrator.events.emit("loop_done", sessionId, {
      status: "done",
      llmSteps: 1,
      toolSteps: 0,
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
    expect(
      sendMessageMock.mock.calls.filter(
        ([message]) =>
          (message as Record<string, unknown>)?.type === "host.command",
      ),
    ).toHaveLength(1);
    expect(await store.listOutboxByTurn("turn-1")).toHaveLength(1);
  });

  it("delivers fresh assistant text even when loop_done status is not done", async () => {
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
      text: "虽然终态失败，但这条答复是新的",
    });

    orchestrator.events.emit("loop_done", sessionId, {
      status: "failed_execute",
      llmSteps: 1,
      toolSteps: 0,
    });

    const deadline = Date.now() + 1000;
    let outbox = await store.listOutboxByTurn("turn-1");
    while (Date.now() < deadline && outbox[0]?.deliveryStatus !== "delivered") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      outbox = await store.listOutboxByTurn("turn-1");
    }

    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.projection.visibleText).toBe("虽然终态失败，但这条答复是新的");
    expect(outbox[0]?.projection.projectionKind).toBe("final_text");
  });

  it("waits briefly for a late assistant entry before falling back to safe_failure", async () => {
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

    orchestrator.events.emit("loop_done", sessionId, {
      status: "done",
      llmSteps: 1,
      toolSteps: 0,
    });

    setTimeout(() => {
      void orchestrator.sessions.appendMessage({
        sessionId,
        role: "assistant",
        text: "late final answer",
      });
    }, 30);

    const deadline = Date.now() + 1000;
    let outbox = await store.listOutboxByTurn("turn-1");
    while (Date.now() < deadline && outbox[0]?.deliveryStatus !== "delivered") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      outbox = await store.listOutboxByTurn("turn-1");
    }

    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.projection.visibleText).toBe("late final answer");
    expect(outbox[0]?.projection.projectionKind).toBe("final_text");
  });

  it("uses llm step_finished preview as a fallback reply source", async () => {
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
    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "old answer",
    });
    const baselineEntry = (await orchestrator.sessions.getEntries(sessionId)).at(-1);
    await store.acceptInbound({
      binding: createBinding(sessionId),
      turn: {
        ...createRunningTurn(sessionId),
        assistantBaselineEntryId: String(baselineEntry?.id || ""),
      },
      initialEvent: null,
    });

    orchestrator.events.emit("step_finished", sessionId, {
      step: 1,
      ok: true,
      mode: "llm",
      preview: "preview final answer",
    });
    orchestrator.events.emit("loop_done", sessionId, {
      status: "done",
      llmSteps: 1,
      toolSteps: 0,
    });

    const deadline = Date.now() + 1000;
    let outbox = await store.listOutboxByTurn("turn-1");
    while (Date.now() < deadline && outbox[0]?.deliveryStatus !== "delivered") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      outbox = await store.listOutboxByTurn("turn-1");
    }

    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.projection.visibleText).toBe("preview final answer");
    expect(outbox[0]?.projection.projectionKind).toBe("final_text");
  });

  it("retries only remaining reply parts with stable client ids after partial send", async () => {
    const hostCalls: Array<Array<Record<string, unknown>>> = [];
    let secondPartClientId = "";
    (globalThis as any).chrome.runtime.sendMessage = vi.fn(
      async (message: Record<string, unknown>) => {
        if (message.type === "host.command" && message.service === "wechat") {
          const parts = (
            (message.payload as Record<string, unknown>)?.parts || []
          ) as Array<Record<string, unknown>>;
          hostCalls.push(parts);
          if (hostCalls.length === 1) {
            secondPartClientId = String(parts[1]?.clientId || "");
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
                deliveredPartCount: 1,
                complete: false,
                lastError: "temporary timeout",
              },
            };
          }
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
              sentAt: "2026-03-22T00:00:02.000Z",
              deliveredPartCount: parts.length,
              complete: true,
            },
          };
        }
        return { ok: true };
      },
    );

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
      text: "x".repeat(WECHAT_REPLY_PART_MAX_CHARS + 25),
    });

    orchestrator.events.emit("loop_done", sessionId, {
      status: "done",
      llmSteps: 1,
      toolSteps: 0,
    });

    const deadline = Date.now() + 1500;
    let turn = await store.getTurn("turn-1");
    while (Date.now() < deadline && turn?.deliveryStatus !== "delivered") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      turn = await store.getTurn("turn-1");
    }

    expect(turn?.deliveryStatus).toBe("delivered");
    expect(hostCalls).toHaveLength(2);
    expect(hostCalls[0]).toHaveLength(2);
    expect(hostCalls[1]).toHaveLength(1);
    expect(String(hostCalls[1]?.[0]?.clientId || "")).toBe(secondPartClientId);
  });

  it("marks delivery dead_letter after exhausting retry budget", async () => {
    (globalThis as any).chrome.runtime.sendMessage = vi.fn(
      async (message: Record<string, unknown>) => {
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
              deliveredPartCount: 0,
              complete: false,
              lastError: "temporary timeout",
            },
          };
        }
        return { ok: true };
      },
    );

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
      text: "fail me",
    });

    orchestrator.events.emit("loop_done", sessionId, {
      status: "done",
      llmSteps: 1,
      toolSteps: 0,
    });

    const deadline = Date.now() + 1500;
    let turn = await store.getTurn("turn-1");
    while (Date.now() < deadline && turn?.deliveryStatus !== "dead_letter") {
      await new Promise((resolve) => setTimeout(resolve, 10));
      turn = await store.getTurn("turn-1");
    }

    expect(turn?.deliveryStatus).toBe("dead_letter");
    const outbox = await store.listOutboxByTurn("turn-1");
    expect(outbox[0]?.deliveryStatus).toBe("dead_letter");
    expect(outbox[0]?.attemptCount).toBe(3);
  });
});
