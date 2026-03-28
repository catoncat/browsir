import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendHostCommand } from "../channel-broker";
import { HOST_PROTOCOL_VERSION } from "../host-protocol";

describe("channel-broker", () => {
  beforeEach(() => {
    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      runtime: {
        ...(globalThis as any).chrome?.runtime,
        getContexts: vi.fn(),
        sendMessage: vi.fn(),
      },
      offscreen: {
        ...(globalThis as any).chrome?.offscreen,
        Reason: { WORKERS: "WORKERS" },
        createDocument: vi.fn(),
      },
    };
  });

  it("creates the offscreen host when absent and returns typed data", async () => {
    const chromeRuntime = (globalThis as any).chrome.runtime;
    chromeRuntime.getContexts.mockResolvedValue([]);
    chromeRuntime.sendMessage.mockResolvedValue({
      type: "host.response",
      protocolVersion: HOST_PROTOCOL_VERSION,
      id: "host-1",
      service: "wechat",
      action: "get_state",
      ok: true,
      data: {
        hostEpoch: "epoch-1",
        protocolVersion: HOST_PROTOCOL_VERSION,
        enabled: false,
        auth: {
          status: "logged_out",
          updatedAt: "2026-03-22T00:00:00.000Z",
        },
        transport: {
          status: "stopped",
          updatedAt: "2026-03-22T00:00:00.000Z",
          resumable: false,
          consecutiveFailures: 0,
        },
        resume: {
          resumable: false,
        },
      },
    });

    const state = await sendHostCommand("wechat", "get_state", {});
    expect(state).toEqual({
      hostEpoch: "epoch-1",
      protocolVersion: HOST_PROTOCOL_VERSION,
      enabled: false,
      auth: {
        status: "logged_out",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
      transport: {
        status: "stopped",
        updatedAt: "2026-03-22T00:00:00.000Z",
        resumable: false,
        consecutiveFailures: 0,
      },
      resume: {
        resumable: false,
      },
    });
    expect((globalThis as any).chrome.offscreen.createDocument).toHaveBeenCalled();
  });

  it("rejects protocol mismatches", async () => {
    const chromeRuntime = (globalThis as any).chrome.runtime;
    chromeRuntime.getContexts.mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
    chromeRuntime.sendMessage.mockResolvedValue({
      type: "host.response",
      protocolVersion: "bbl.host.v999",
      id: "host-1",
      service: "wechat",
      action: "get_state",
      ok: true,
      data: {},
    });

    await expect(sendHostCommand("wechat", "get_state", {})).rejects.toThrow(
      "Host protocol mismatch",
    );
  });
});
