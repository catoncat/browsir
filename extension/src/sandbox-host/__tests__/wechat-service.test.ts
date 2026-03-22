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
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] || [];
    expect(String(url || "")).toContain("/ilink/bot/sendmessage");
    const body = JSON.parse(String((init as RequestInit)?.body || "{}")) as {
      msg?: { context_token?: string; to_user_id?: string; item_list?: Array<{ text_item?: { text?: string } }> };
    };
    expect(body.msg?.context_token).toBe("ctx-1");
    expect(body.msg?.to_user_id).toBe("user-1");
    expect(body.msg?.item_list?.[0]?.text_item?.text).toBe("hello");
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
      const cached = JSON.parse(
        localStorage.getItem("bbl.wechat.host.context-tokens.v1") || "{}",
      ) as Record<string, string>;
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
});
