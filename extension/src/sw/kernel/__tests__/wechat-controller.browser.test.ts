import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";
import { registerRuntimeRouter } from "../runtime-router";
import { HOST_PROTOCOL_VERSION } from "../host-protocol";

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
  beforeEach(() => {
    runtimeListeners = [];
    resetRuntimeOnMessageMock();
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
});
