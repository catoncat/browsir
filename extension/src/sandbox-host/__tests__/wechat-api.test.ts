import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchQrCode, pollQrStatus } from "../wechat-api";

describe("wechat-api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchQrCode calls the ilink QR endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            qrcode: "qr-token",
            qrcode_img_content: "https://example.com/qr.png",
          }),
          { status: 200 },
        ),
      );

    const result = await fetchQrCode();
    expect(result.qrcode).toBe("qr-token");
    expect(result.qrcode_img_content).toContain("qr.png");
    expect(String(fetchMock.mock.calls[0]?.[0] || "")).toContain(
      "/ilink/bot/get_bot_qrcode?bot_type=3",
    );
  });

  it("pollQrStatus includes the client version header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "wait",
          }),
          { status: 200 },
        ),
      );

    await pollQrStatus("https://ilinkai.weixin.qq.com", "qr-token");
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((options.headers as Record<string, string>)["iLink-App-ClientVersion"]).toBe("1");
  });
});
