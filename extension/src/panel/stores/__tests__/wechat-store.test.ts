import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { sendMessage } from "../send-message";
import { useWechatStore } from "../wechat-store";

vi.mock("../send-message", () => ({
  sendMessage: vi.fn(),
}));

describe("wechat-store", () => {
  const sendMessageMock = sendMessage as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    sendMessageMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refresh loads current host state", async () => {
    const store = useWechatStore();
    sendMessageMock.mockResolvedValueOnce({
      hostEpoch: "epoch-1",
      protocolVersion: "bbl.host.v1",
      login: {
        status: "logged_out",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
    });

    await store.refresh();

    expect(sendMessageMock).toHaveBeenCalledWith("brain.channel.wechat.get_state");
    expect(store.state.hostEpoch).toBe("epoch-1");
    expect(store.state.login.status).toBe("logged_out");
    expect(store.ready).toBe(true);
    expect(store.loading).toBe(false);
  });

  it("startLogin and logout update state through runtime routes", async () => {
    const store = useWechatStore();
    sendMessageMock
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        login: {
          status: "pending",
          updatedAt: "2026-03-22T00:00:01.000Z",
        },
      })
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        login: {
          status: "logged_out",
          updatedAt: "2026-03-22T00:00:02.000Z",
        },
      });

    await store.startLogin();
    expect(store.state.login.status).toBe("pending");

    await store.logout();
    expect(store.state.login.status).toBe("logged_out");
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      1,
      "brain.channel.wechat.login.start",
    );
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      2,
      "brain.channel.wechat.logout",
    );
  });

  it("captures runtime errors without leaving loading stuck", async () => {
    const store = useWechatStore();
    sendMessageMock.mockRejectedValueOnce(new Error("bridge down"));

    await store.refresh();

    expect(store.error).toContain("bridge down");
    expect(store.ready).toBe(true);
    expect(store.loading).toBe(false);
  });

  it("connect enables the channel and starts login in one action", async () => {
    const store = useWechatStore();
    sendMessageMock
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_out",
          updatedAt: "2026-03-22T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "pending",
          updatedAt: "2026-03-22T00:00:01.000Z",
          qrImageUrl: "https://example.com/qr.png",
        },
      });

    await store.connect();

    expect(sendMessageMock).toHaveBeenNthCalledWith(1, "brain.channel.wechat.enable");
    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "brain.channel.wechat.login.start");
    expect(store.state.enabled).toBe(true);
    expect(store.state.login.status).toBe("pending");
  });

  it("connect skips enable when the channel is already enabled", async () => {
    const store = useWechatStore();
    store.state.enabled = true;
    sendMessageMock.mockResolvedValueOnce({
      hostEpoch: "epoch-1",
      protocolVersion: "bbl.host.v1",
      enabled: true,
      login: {
        status: "pending",
        updatedAt: "2026-03-22T00:00:01.000Z",
        qrImageUrl: "https://example.com/qr.png",
      },
    });

    await store.connect();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("brain.channel.wechat.login.start");
    expect(store.state.login.status).toBe("pending");
  });

  it("connect starts a fresh login when persisted logged_in state exists but the channel was disabled", async () => {
    const store = useWechatStore();
    store.state.login.status = "logged_in";
    store.state.login.accountId = "bot-1";
    store.state.login.botUserId = "user-1";
    sendMessageMock
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:01.000Z",
          accountId: "bot-1",
          botUserId: "user-1",
        },
      })
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "pending",
          updatedAt: "2026-03-22T00:00:02.000Z",
          qrImageUrl: "https://example.com/qr.png",
        },
      });

    await store.connect();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).toHaveBeenNthCalledWith(1, "brain.channel.wechat.enable");
    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "brain.channel.wechat.login.start");
    expect(store.state.enabled).toBe(true);
    expect(store.state.login.status).toBe("pending");
  });

  it("disconnect clears a pending login before disabling the channel", async () => {
    const store = useWechatStore();
    store.state.enabled = true;
    store.state.login.status = "pending";
    store.state.login.qrCode = "qr-token";
    store.state.login.qrImageUrl = "https://example.com/qr.png";
    sendMessageMock
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_out",
          updatedAt: "2026-03-22T00:00:02.000Z",
        },
      })
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: false,
        login: {
          status: "logged_out",
          updatedAt: "2026-03-22T00:00:03.000Z",
        },
      });

    await store.disconnect();

    expect(sendMessageMock).toHaveBeenNthCalledWith(1, "brain.channel.wechat.logout");
    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "brain.channel.wechat.disable");
    expect(store.state.enabled).toBe(false);
    expect(store.state.login.status).toBe("logged_out");
  });

  it("refresh schedules background polling while login is pending", async () => {
    const store = useWechatStore();
    sendMessageMock
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "pending",
          updatedAt: "2026-03-22T00:00:01.000Z",
          qrImageUrl: "https://example.com/qr.png",
        },
      })
      .mockResolvedValueOnce({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:02.000Z",
          accountId: "bot-1",
          botUserId: "user-1",
        },
      });

    await store.refresh();
    expect(store.state.login.status).toBe("pending");

    vi.advanceTimersByTime(1200);
    await Promise.resolve();

    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "brain.channel.wechat.get_state");
    expect(store.state.login.status).toBe("logged_in");
  });
});
