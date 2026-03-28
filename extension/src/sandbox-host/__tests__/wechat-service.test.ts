import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WechatHostService } from "../wechat-service";

class LocalStorageMock {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

function readStoredContextTokens(): Record<string, string> {
  const raw = localStorage.getItem("bbl.wechat.host.context-tokens.v1") || "{}";
  const parsed = JSON.parse(raw) as Record<string, string | { token?: string }>;
  return Object.fromEntries(
    Object.entries(parsed).map(([userId, value]) => [
      userId,
      typeof value === "string" ? value : String(value?.token || ""),
    ]),
  );
}

describe("wechat-service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "localStorage", {
      value: new LocalStorageMock(),
      configurable: true,
    });
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("startLogin stores pending QR state and schedules polling", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            qrcode: "qr-token",
            qrcode_img_content: "https://example.com/qr.png",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "wait",
          }),
          { status: 200 },
        ),
      );

    const service = new WechatHostService();
    const state = await service.startLogin();
    expect(state.login.status).toBe("pending");
    expect(state.login.qrCode).toBe("qr-token");
    expect(state.login.qrImageUrl).toContain("qr.png");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.getState().login.status).toBe("pending");
  });

  it("startLogin clears stale cursor and cached context tokens before requesting a new QR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          qrcode: "qr-token",
          qrcode_img_content: "https://example.com/qr.png",
        }),
        { status: 200 },
      ),
    );
    localStorage.setItem("bbl.wechat.host.cursor.v1", "old-cursor");
    localStorage.setItem(
      "bbl.wechat.host.context-tokens.v1",
      JSON.stringify({ "user-old": "ctx-old" }),
    );
    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "old-token",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "old-bot",
        userId: "old-user",
      }),
    );

    const service = new WechatHostService();
    await service.startLogin();

    expect(localStorage.getItem("bbl.wechat.host.cursor.v1")).toBeNull();
    expect(localStorage.getItem("bbl.wechat.host.context-tokens.v1")).toBeNull();
    expect(localStorage.getItem("bbl.wechat.host.credentials.v1")).toBeNull();
  });

  it("polling confirmation promotes state to logged_in and persists credentials", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            qrcode: "qr-token",
            qrcode_img_content: "https://example.com/qr.png",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "confirmed",
            bot_token: "token-1",
            ilink_bot_id: "bot-1",
            ilink_user_id: "user-1",
            baseurl: "https://ilinkai.weixin.qq.com",
          }),
          { status: 200 },
        ),
      );

    const service = new WechatHostService();
    await service.startLogin();
    await vi.advanceTimersByTimeAsync(2_000);

    const state = service.getState();
    expect(state.login.status).toBe("logged_in");
    expect(state.login.accountId).toBe("bot-1");
    expect(state.login.botUserId).toBe("user-1");
  });

  it("sendReply uses cached context_token and sendmessage endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
    );
    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.context-tokens.v1",
      JSON.stringify({
        "user-1": "ctx-1",
      }),
    );

    const service = new WechatHostService();
    const result = await service.sendReply({
      deliveryId: "delivery-1",
      channelTurnId: "turn-1",
      sessionId: "session-1",
      userId: "user-1",
      parts: [{ kind: "text", text: "hello" }],
    });

    expect(result.deliveryId).toBe("delivery-1");
    expect(result.deliveredPartCount).toBe(1);
    expect(result.complete).toBe(true);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] || [];
    expect(String(url || "")).toContain("/ilink/bot/sendmessage");
    const body = JSON.parse(String((init as RequestInit)?.body || "{}")) as {
      msg?: { context_token?: string; to_user_id?: string; item_list?: Array<{ text_item?: { text?: string } }> };
    };
    expect(body.msg?.context_token).toBe("ctx-1");
    expect(body.msg?.to_user_id).toBe("user-1");
    expect(body.msg?.item_list?.[0]?.text_item?.text).toBe("hello");
  });

  it("sendReply reports partial progress without regenerating client ids", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: 0 }), { status: 200 }))
      .mockRejectedValueOnce(new Error("temporary timeout"));
    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.context-tokens.v1",
      JSON.stringify({
        "user-1": { token: "ctx-1", updatedAt: "2026-03-22T00:00:00.000Z" },
      }),
    );

    const service = new WechatHostService();
    const result = await service.sendReply({
      deliveryId: "delivery-1",
      channelTurnId: "turn-1",
      sessionId: "session-1",
      userId: "user-1",
      parts: [
        { kind: "text", text: "part-1", clientId: "part-client-1" },
        { kind: "text", text: "part-2", clientId: "part-client-2" },
      ],
    });

    expect(result.deliveredPartCount).toBe(1);
    expect(result.complete).toBe(false);
    const secondCallBody = JSON.parse(
      String((vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit)?.body || "{}"),
    ) as { msg?: { client_id?: string } };
    expect(secondCallBody.msg?.client_id).toBe("part-client-2");
  });

  it("confirmed login can poll updates, cache context token, and use it for reply", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            qrcode: "qr-token",
            qrcode_img_content: "https://example.com/qr.png",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "confirmed",
            bot_token: "token-1",
            ilink_bot_id: "bot-1",
            ilink_user_id: "bot-user",
            baseurl: "https://ilinkai.weixin.qq.com",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ret: 0,
            msgs: [
              {
                message_id: 1,
                from_user_id: "user-2",
                to_user_id: "bot-user",
                client_id: "client-1",
                create_time_ms: Date.parse("2026-03-22T00:00:01.000Z"),
                message_type: 1,
                message_state: 2,
                context_token: "ctx-2",
                item_list: [
                  { type: 1, text_item: { text: "hello from wechat" } },
                ],
              },
            ],
            get_updates_buf: "cursor-1",
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
      );

    (globalThis as any).chrome.runtime.sendMessage = vi.fn(async (message: Record<string, unknown>) => {
      if (message.type === "brain.channel.wechat.inbound") {
        return { ok: true, data: { status: "accepted" } };
      }
      return { ok: true };
    });

    const service = new WechatHostService();
    service.enable();
    await service.startLogin();
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 0; i < 20; i += 1) {
      const cached = readStoredContextTokens();
      if (cached["user-2"] === "ctx-2") break;
      await vi.advanceTimersByTimeAsync(10);
    }

    await service.sendReply({
      deliveryId: "delivery-2",
      channelTurnId: "turn-2",
      sessionId: "session-2",
      userId: "user-2",
      parts: [{ kind: "text", text: "reply after poll" }],
    });

    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.channel.wechat.inbound",
        remoteUserId: "user-2",
      }),
    );

    const fetchCalls = vi.mocked(globalThis.fetch).mock.calls;
    const sendCall = fetchCalls.at(-1);
    expect(String(sendCall?.[0] || "")).toContain("/ilink/bot/sendmessage");
    const body = JSON.parse(String((sendCall?.[1] as RequestInit)?.body || "{}")) as {
      msg?: { context_token?: string };
    };
    expect(body.msg?.context_token).toBe("ctx-2");
  });

  it("ignores self-authored update echoes while still caching peer context tokens", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ret: 0,
            msgs: [
              {
                message_id: 7,
                from_user_id: "bot-user",
                to_user_id: "user-4",
                client_id: "client-7",
                create_time_ms: Date.parse("2026-03-22T00:00:07.000Z"),
                message_type: 1,
                message_state: 2,
                context_token: "ctx-4",
                item_list: [{ type: 1, text_item: { text: "bot echo" } }],
              },
            ],
            get_updates_buf: "cursor-7",
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    const sendMessageMock = vi.fn(async (message: Record<string, unknown>) => {
      if (message.type === "brain.channel.wechat.inbound") {
        return { ok: true, data: { status: "accepted" } };
      }
      return { ok: true };
    });
    (globalThis as any).chrome.runtime.sendMessage = sendMessageMock;

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    expect(service.getState().login.status).toBe("logged_in");

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(20);
      const cached = readStoredContextTokens();
      if (cached["user-4"] === "ctx-4") break;
    }

    const cached = readStoredContextTokens();
    expect(cached["user-4"]).toBe("ctx-4");
    expect(cached["bot-user"]).toBeUndefined();
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.channel.wechat.inbound",
      }),
    );
  });

  it("accepts inbound text addressed to bot accountId and caches token by peer user", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ret: 0,
            msgs: [
              {
                message_id: 8,
                from_user_id: "user-8",
                to_user_id: "bot-account",
                client_id: "client-8",
                create_time_ms: Date.parse("2026-03-22T00:00:08.000Z"),
                message_type: 1,
                message_state: 2,
                context_token: "ctx-8",
                item_list: [{ type: 1, text_item: { text: "hello account bot" } }],
              },
            ],
            get_updates_buf: "cursor-8",
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    const sendMessageMock = vi.fn(async (message: Record<string, unknown>) => {
      if (message.type === "brain.channel.wechat.inbound") {
        return { ok: true, data: { status: "accepted" } };
      }
      return { ok: true };
    });
    (globalThis as any).chrome.runtime.sendMessage = sendMessageMock;

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-account",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-account",
          botUserId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    expect(service.getState().login.status).toBe("logged_in");

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(20);
      const cached = readStoredContextTokens();
      if (cached["user-8"] === "ctx-8") break;
    }

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.channel.wechat.inbound",
        remoteUserId: "user-8",
        remoteConversationId: "user-8",
        text: "hello account bot",
      }),
    );
    const cached = readStoredContextTokens();
    expect(cached["user-8"]).toBe("ctx-8");
  });

  it("accepts inbound text when the linked wechat user sends to the bot account", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ret: 0,
            msgs: [
              {
                message_id: 9,
                from_user_id: "wechat-user",
                to_user_id: "bot-account",
                client_id: "client-9",
                create_time_ms: Date.parse("2026-03-22T00:00:09.000Z"),
                message_type: 1,
                message_state: 2,
                context_token: "ctx-9",
                item_list: [{ type: 1, text_item: { text: "hello real packet" } }],
              },
            ],
            get_updates_buf: "cursor-9",
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    const sendMessageMock = vi.fn(async (message: Record<string, unknown>) => {
      if (message.type === "brain.channel.wechat.inbound") {
        return { ok: true, data: { status: "accepted" } };
      }
      return { ok: true };
    });
    (globalThis as any).chrome.runtime.sendMessage = sendMessageMock;

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-account",
        userId: "wechat-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-account",
          botUserId: "wechat-user",
        },
      }),
    );

    const service = new WechatHostService();
    expect(service.getState().login.status).toBe("logged_in");

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(20);
      const cached = readStoredContextTokens();
      if (cached["wechat-user"] === "ctx-9") break;
    }

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.channel.wechat.inbound",
        remoteUserId: "wechat-user",
        remoteConversationId: "wechat-user",
        text: "hello real packet",
      }),
    );
    const cached = readStoredContextTokens();
    expect(cached["wechat-user"]).toBe("ctx-9");
  });

  it("does not enter error state when UI refresh overlaps an in-flight update poll", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise(() => {}));

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    await vi.advanceTimersByTimeAsync(0);

    const state = service.getState();
    expect(state.login.status).toBe("logged_in");

    await vi.advanceTimersByTimeAsync(50);
    expect(service.getState().login.status).toBe("logged_in");
  });

  it("keeps logged_in state when getupdates hits a long-poll timeout", async () => {
    const timeoutError = new Error("signal timed out");
    timeoutError.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(timeoutError)
      .mockImplementationOnce(() => new Promise(() => {}));

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);

    const state = service.getState();
    expect(state.login.status).toBe("logged_in");
    expect(state.login.lastError).toBeUndefined();
  });

  it("does not force an immediate retry when getState is polled after a poll error", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("bridge exploded"))
      .mockImplementationOnce(() => new Promise(() => {}));

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);

    service.getState();
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(service.getState().login.status).toBe("error");
  });

  it("does not start a second update poll while inbound delivery is still running", async () => {
    let resolveInbound!: (value: { ok: true; data: { status: "accepted" } }) => void;
    const inboundDeferred = new Promise<{ ok: true; data: { status: "accepted" } }>((resolve) => {
      resolveInbound = resolve;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ret: 0,
            msgs: [
              {
                message_id: 10,
                from_user_id: "user-10",
                to_user_id: "bot-user",
                client_id: "client-10",
                create_time_ms: Date.parse("2026-03-22T00:00:10.000Z"),
                message_type: 1,
                message_state: 2,
                context_token: "ctx-10",
                item_list: [{ type: 1, text_item: { text: "hello overlap" } }],
              },
            ],
            get_updates_buf: "cursor-10",
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    (globalThis as any).chrome.runtime.sendMessage = vi.fn(async (message: Record<string, unknown>) => {
      if (message.type === "brain.channel.wechat.inbound") {
        return inboundDeferred;
      }
      return { ok: true };
    });

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);

    service.getState();
    await vi.advanceTimersByTimeAsync(20);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);

    resolveInbound({ ok: true, data: { status: "accepted" } });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it("treats unrelated 'Transaction aborted' errors as real poll failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Transaction aborted by storage engine"),
    );

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);

    expect(service.getState().login.status).toBe("error");
    expect(service.getState().login.lastError).toContain("Transaction aborted");
  });

  it("prunes oversized context token ledgers on send", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ret: 0 }), { status: 200 }),
    );
    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.context-tokens.v1",
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 205 }, (_, index) => [
            `user-${index}`,
            {
              token: `ctx-${index}`,
              updatedAt: `2026-03-22T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
            },
          ]),
        ),
      ),
    );

    const service = new WechatHostService();
    await service.sendReply({
      deliveryId: "delivery-prune",
      channelTurnId: "turn-prune",
      sessionId: "session-prune",
      userId: "user-204",
      parts: [{ kind: "text", text: "hello" }],
    });

    const stored = JSON.parse(
      localStorage.getItem("bbl.wechat.host.context-tokens.v1") || "{}",
    ) as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(200);
    expect(readStoredContextTokens()["user-204"]).toBe("ctx-204");
  });

  it("resumes update polling after host service is reconstructed while still logged in", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ret: 0,
            msgs: [
              {
                message_id: 2,
                from_user_id: "user-3",
                to_user_id: "bot-user",
                client_id: "client-2",
                create_time_ms: Date.parse("2026-03-22T00:00:02.000Z"),
                message_type: 1,
                message_state: 2,
                context_token: "ctx-3",
                item_list: [
                  { type: 1, text_item: { text: "wake up" } },
                ],
              },
            ],
            get_updates_buf: "cursor-2",
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    localStorage.setItem(
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "epoch-1",
        protocolVersion: "bbl.host.v1",
        enabled: true,
        login: {
          status: "logged_in",
          updatedAt: "2026-03-22T00:00:00.000Z",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
      }),
    );

    const sendMessageMock = vi.fn(async (message: Record<string, unknown>) => {
      if (message.type === "brain.channel.wechat.inbound") {
        return { ok: true, data: { status: "accepted" } };
      }
      return { ok: true };
    });
    (globalThis as any).chrome.runtime.sendMessage = sendMessageMock;

    const service = new WechatHostService();
    expect(service.getState().login.status).toBe("logged_in");

    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(20);
      const cached = readStoredContextTokens();
      if (cached["user-3"] === "ctx-3") break;
    }

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.channel.wechat.inbound",
        remoteUserId: "user-3",
        text: "wake up",
      }),
    );
    const cached = readStoredContextTokens();
    expect(cached["user-3"]).toBe("ctx-3");
  });
});
