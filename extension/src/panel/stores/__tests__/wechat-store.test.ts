import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { sendMessage } from "../send-message";
import { useWechatStore } from "../wechat-store";

vi.mock("../send-message", () => ({
  sendMessage: vi.fn(),
}));

describe("wechat-store", () => {
  const sendMessageMock = vi.mocked(sendMessage);

  beforeEach(() => {
    setActivePinia(createPinia());
    sendMessageMock.mockReset();
  });

  afterEach(() => {
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
    expect(store.loading).toBe(false);
  });
});
