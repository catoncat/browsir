import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { HOST_PROTOCOL_VERSION } from "../../../sw/kernel/host-protocol";
import { sendMessage } from "../send-message";
import { useWechatStore, type WechatPanelState } from "../wechat-store";

vi.mock("../send-message", () => ({
  sendMessage: vi.fn(),
}));

function buildState(
  patch: {
    hostEpoch?: string;
    protocolVersion?: WechatPanelState["protocolVersion"];
    enabled?: boolean;
    auth?: Partial<WechatPanelState["auth"]>;
    transport?: Partial<WechatPanelState["transport"]>;
    resume?: Partial<WechatPanelState["resume"]>;
  } = {},
): WechatPanelState {
  return {
    hostEpoch: patch.hostEpoch ?? "epoch-1",
    protocolVersion: patch.protocolVersion ?? HOST_PROTOCOL_VERSION,
    enabled: patch.enabled ?? false,
    auth: {
      status: "logged_out",
      updatedAt: "2026-03-22T00:00:00.000Z",
      ...patch.auth,
    } as WechatPanelState["auth"],
    transport: {
      status: "stopped",
      updatedAt: "2026-03-22T00:00:00.000Z",
      resumable: false,
      consecutiveFailures: 0,
      ...patch.transport,
    } as WechatPanelState["transport"],
    resume: {
      resumable: false,
      ...patch.resume,
    } as WechatPanelState["resume"],
  };
}

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
    sendMessageMock.mockResolvedValueOnce(buildState());

    await store.refresh();

    expect(sendMessageMock).toHaveBeenCalledWith("brain.channel.wechat.get_state");
    expect(store.state.hostEpoch).toBe("epoch-1");
    expect(store.state.auth.status).toBe("logged_out");
    expect(store.ready).toBe(true);
    expect(store.loading).toBe(false);
  });

  it("startLogin and logout update state through runtime routes", async () => {
    const store = useWechatStore();
    sendMessageMock
      .mockResolvedValueOnce(
        buildState({
          auth: {
            status: "pending_qr",
            updatedAt: "2026-03-22T00:00:01.000Z",
            qrImageUrl: "https://example.com/qr.png",
          },
          resume: { resumable: true },
        }),
      )
      .mockResolvedValueOnce(buildState());

    await store.startLogin();
    expect(store.state.auth.status).toBe("pending_qr");

    await store.logout();
    expect(store.state.auth.status).toBe("logged_out");
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

  it("connect enables the channel then resumes an authenticated session", async () => {
    const store = useWechatStore();
    store.state = buildState({
      auth: {
        status: "authenticated",
        accountId: "bot-1",
        botUserId: "user-1",
      },
      resume: { resumable: true },
    });
    sendMessageMock
      .mockResolvedValueOnce(
        buildState({
          enabled: true,
          auth: {
            status: "authenticated",
            accountId: "bot-1",
            botUserId: "user-1",
          },
          transport: {
            status: "degraded",
            resumable: true,
          },
          resume: { resumable: true },
        }),
      )
      .mockResolvedValueOnce(
        buildState({
          enabled: true,
          auth: {
            status: "authenticated",
            accountId: "bot-1",
            botUserId: "user-1",
          },
          transport: {
            status: "starting",
            resumable: true,
          },
          resume: {
            resumable: true,
            lastResumeReason: "panel_connect",
          },
        }),
      );

    await store.connect();

    expect(sendMessageMock).toHaveBeenNthCalledWith(1, "brain.channel.wechat.enable");
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      2,
      "brain.channel.wechat.resume",
      { reason: "panel_connect" },
    );
    expect(store.state.enabled).toBe(true);
    expect(store.state.auth.status).toBe("authenticated");
    expect(store.state.transport.status).toBe("starting");
  });

  it("connect starts a fresh login when the channel has no reusable auth", async () => {
    const store = useWechatStore();
    sendMessageMock
      .mockResolvedValueOnce(buildState({ enabled: true }))
      .mockResolvedValueOnce(
        buildState({
          enabled: true,
          auth: {
            status: "pending_qr",
            qrCode: "qr-token",
            qrImageUrl: "https://example.com/qr.png",
          },
          resume: { resumable: true },
        }),
      );

    await store.connect();

    expect(sendMessageMock).toHaveBeenNthCalledWith(1, "brain.channel.wechat.enable");
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      2,
      "brain.channel.wechat.login.start",
    );
    expect(store.state.auth.status).toBe("pending_qr");
  });

  it("disconnect clears the session before disabling the channel", async () => {
    const store = useWechatStore();
    store.state = buildState({
      enabled: true,
      auth: {
        status: "pending_qr",
        qrCode: "qr-token",
        qrImageUrl: "https://example.com/qr.png",
      },
      resume: { resumable: true },
    });
    sendMessageMock
      .mockResolvedValueOnce(buildState())
      .mockResolvedValueOnce(buildState());

    await store.disconnect();

    expect(sendMessageMock).toHaveBeenNthCalledWith(1, "brain.channel.wechat.logout");
    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "brain.channel.wechat.disable");
    expect(store.state.enabled).toBe(false);
    expect(store.state.auth.status).toBe("logged_out");
  });

  it("refresh keeps polling while qr login is pending", async () => {
    const store = useWechatStore();
    sendMessageMock
      .mockResolvedValueOnce(
        buildState({
          enabled: true,
          auth: {
            status: "pending_qr",
            qrImageUrl: "https://example.com/qr.png",
          },
          resume: { resumable: true },
        }),
      )
      .mockResolvedValueOnce(
        buildState({
          enabled: true,
          auth: {
            status: "authenticated",
            accountId: "bot-1",
            botUserId: "user-1",
          },
          transport: {
            status: "healthy",
            resumable: true,
          },
          resume: { resumable: true },
        }),
      );

    await store.refresh();
    expect(store.state.auth.status).toBe("pending_qr");

    vi.advanceTimersByTime(1200);
    await Promise.resolve();

    expect(sendMessageMock).toHaveBeenNthCalledWith(2, "brain.channel.wechat.get_state");
    expect(store.state.auth.status).toBe("authenticated");
  });
});
