import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";
import { registerRuntimeRouter } from "../runtime-router";
import { HOST_PROTOCOL_VERSION } from "../host-protocol";
import { clearIdbStores } from "../idb-storage";
import { handleBrainChannelWechat } from "../runtime-router/wechat-controller";

type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (value: unknown) => void,
) => boolean | void;

let runtimeListeners: RuntimeListener[] = [];

function resetRuntimeOnMessageMock(): void {
  const onMessage = chrome.runtime.onMessage as unknown as {
    addListener: (cb: RuntimeListener) => void;
    removeListener: (cb: RuntimeListener) => void;
    hasListener: (cb: RuntimeListener) => boolean;
  };
  onMessage.addListener = (cb) => {
    runtimeListeners.push(cb);
  };
  onMessage.removeListener = (cb) => {
    runtimeListeners = runtimeListeners.filter((item) => item !== cb);
  };
  onMessage.hasListener = (cb) => runtimeListeners.includes(cb);
}

function buildWechatResponse(
  action: string,
  status: "logged_out" | "pending" | "logged_in" | "error",
) {
  return {
    type: "host.response",
    protocolVersion: HOST_PROTOCOL_VERSION,
    id: `host-${action}`,
    service: "wechat",
    action,
    ok: true,
    data: {
      hostEpoch: "epoch-1",
      protocolVersion: HOST_PROTOCOL_VERSION,
      login: {
        status,
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
    },
  };
}

async function invokeRuntime(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!runtimeListeners.length) {
      reject(new Error("runtime listener not registered"));
      return;
    }

    for (const listener of runtimeListeners) {
      listener(message, {}, (response) => {
        resolve((response || {}) as Record<string, unknown>);
      });
      return;
    }
  });
}

describe("wechat-controller.browser", () => {
  beforeEach(async () => {
    runtimeListeners = [];
    resetRuntimeOnMessageMock();
    await clearIdbStores();
    (globalThis as any).chrome.runtime.getContexts = vi.fn().mockResolvedValue([
      { contextType: "OFFSCREEN_DOCUMENT" },
    ]);
    (globalThis as any).chrome.runtime.sendMessage = vi
      .fn()
      .mockImplementation(async (message: Record<string, unknown>) => {
        if (message.type === "bbloop.ui.state.query") return { ok: false };
        if (message.type === "host.command" && message.service === "wechat") {
          if (message.action === "get_state") {
            return buildWechatResponse("get_state", "logged_out");
          }
          if (message.action === "login.start") {
            return buildWechatResponse("login.start", "pending");
          }
          if (message.action === "logout") {
            return buildWechatResponse("logout", "logged_out");
          }
        }
        return { ok: true };
      });
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
  });

  it("routes brain.channel.wechat.get_state through the host broker", async () => {
    const result = await invokeRuntime({
      type: "brain.channel.wechat.get_state",
    });

    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>).login).toEqual({
      status: "logged_out",
      updatedAt: "2026-03-22T00:00:00.000Z",
    });
  });

  it("routes brain.channel.wechat.login.start and logout through the host broker", async () => {
    const login = await invokeRuntime({
      type: "brain.channel.wechat.login.start",
    });
    expect(login.ok).toBe(true);
    expect(
      ((login.data as Record<string, unknown>).login as Record<string, unknown>)
        .status,
    ).toBe("pending");

    const logout = await invokeRuntime({
      type: "brain.channel.wechat.logout",
    });
    expect(logout.ok).toBe(true);
    expect(
      ((logout.data as Record<string, unknown>).login as Record<string, unknown>)
        .status,
    ).toBe("logged_out");
  });

  it("accepts inbound text, creates binding/turn, and appends a session user message", async () => {
    const orchestrator = new BrainOrchestrator();
    const runtimeLoop = {
      startFromPrompt: vi.fn(async (input: { sessionId: string; prompt: string }) => {
        await orchestrator.appendUserMessage(input.sessionId, input.prompt, {
          metadata: { source: "remote_channel" },
        });
        orchestrator.setRunning(input.sessionId, true);
        return {
          sessionId: input.sessionId,
          runtime: orchestrator.getRunState(input.sessionId),
        };
      }),
    } as any;

    const result = await handleBrainChannelWechat(orchestrator, runtimeLoop, {
      type: "brain.channel.wechat.inbound",
      remoteConversationId: "conv-1",
      remoteUserId: "user-1",
      remoteMessageId: "msg-1",
      text: "hello from wechat",
    });

    expect(result.ok).toBe(true);
    const data = result.ok ? (result.data as Record<string, unknown>) : {};
    expect(data.status).toBe("accepted");
    expect(data.queuedMode).toBe("start");

    const sessionId = String(data.sessionId || "");
    const entries = await orchestrator.sessions.getEntries(sessionId);
    expect(entries.at(-1)).toMatchObject({
      type: "message",
      role: "user",
      text: "hello from wechat",
    });

    const binding = await orchestrator.channels.store.getBinding("wechat", "conv-1");
    expect(binding?.sessionId).toBe(sessionId);
    const turn = await orchestrator.channels.store.getTurn(
      String(data.channelTurnId || ""),
    );
    expect(turn?.remoteMessageId).toBe("msg-1");
    expect(turn?.lifecycleStatus).toBe("running");
  });

  it("queues followUp inbound when the mapped session is already running", async () => {
    const orchestrator = new BrainOrchestrator();
    const created = await orchestrator.createSession({
      metadata: {
        channel: {
          kind: "wechat",
          remoteConversationId: "conv-2",
          remoteUserId: "user-2",
        },
      },
    });
    await orchestrator.channels.store.acceptInbound({
      binding: {
        bindingKey: "wechat:conv-2",
        channelConversationKey: "wechat:conv-2",
        channelKind: "wechat",
        remoteConversationId: "conv-2",
        remoteUserId: "user-2",
        sessionId: created.sessionId,
        trustTier: "external_remote",
        sourceLabel: "wechat",
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
      turn: {
        channelTurnId: "existing-turn",
        bindingKey: "wechat:conv-2",
        remoteMessageKey: "wechat:conv-2:msg-existing",
        channelKind: "wechat",
        remoteConversationId: "conv-2",
        remoteUserId: "user-2",
        remoteMessageId: "msg-existing",
        sessionId: created.sessionId,
        queuedMode: "start",
        lifecycleStatus: "running",
        dispatchStatus: "queued",
        deliveryStatus: "not_requested",
        interventionStatus: "none",
        repairStatus: "none",
        anomalyFlags: [],
        runAttemptCount: 1,
        sourceLabel: "wechat",
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
      initialEvent: null,
    });
    orchestrator.setRunning(created.sessionId, true);

    const runtimeLoop = {
      startFromPrompt: vi.fn(),
    } as any;

    const result = await handleBrainChannelWechat(orchestrator, runtimeLoop, {
      type: "brain.channel.wechat.inbound",
      remoteConversationId: "conv-2",
      remoteUserId: "user-2",
      remoteMessageId: "msg-2",
      text: "queued follow up",
    });

    expect(result.ok).toBe(true);
    const data = result.ok ? (result.data as Record<string, unknown>) : {};
    expect(data.queuedMode).toBe("followUp");
    expect(runtimeLoop.startFromPrompt).not.toHaveBeenCalled();
    const runtime = orchestrator.getRunState(created.sessionId);
    expect(runtime.queue.followUp).toBe(1);

    const entries = await orchestrator.sessions.getEntries(created.sessionId);
    expect(entries.at(-1)).toMatchObject({
      type: "message",
      role: "user",
      text: "queued follow up",
    });
  });

  it("returns duplicate for the same remote message id", async () => {
    const orchestrator = new BrainOrchestrator();
    const runtimeLoop = {
      startFromPrompt: vi.fn(async (input: { sessionId: string; prompt: string }) => {
        await orchestrator.appendUserMessage(input.sessionId, input.prompt);
        return {
          sessionId: input.sessionId,
          runtime: orchestrator.getRunState(input.sessionId),
        };
      }),
    } as any;

    const first = await handleBrainChannelWechat(orchestrator, runtimeLoop, {
      type: "brain.channel.wechat.inbound",
      remoteConversationId: "conv-3",
      remoteUserId: "user-3",
      remoteMessageId: "msg-3",
      text: "hello once",
    });
    expect(first.ok).toBe(true);

    const second = await handleBrainChannelWechat(orchestrator, runtimeLoop, {
      type: "brain.channel.wechat.inbound",
      remoteConversationId: "conv-3",
      remoteUserId: "user-3",
      remoteMessageId: "msg-3",
      text: "hello twice",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error(second.error);
    }
    expect((second.data as Record<string, unknown>).status).toBe("duplicate");
  });
});
