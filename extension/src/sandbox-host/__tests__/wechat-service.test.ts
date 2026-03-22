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
});
