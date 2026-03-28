import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_PROTOCOL_VERSION } from "../../sw/kernel/host-protocol";
import { WechatApiError } from "../wechat-api";
import { WechatHostService } from "../wechat-service";

const WECHAT_RUNTIME_KEY = "bbl.wechat.runtime.v2";

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

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function createStorageArea() {
  let store: Record<string, unknown> = {};

  return {
    async get(keys?: string | string[] | null) {
      if (keys === null || keys === undefined) return clone(store);
      if (typeof keys === "string") return { [keys]: clone(store[keys]) };
      const out: Record<string, unknown> = {};
      for (const key of keys) out[key] = clone(store[key]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      store = { ...store, ...clone(items) };
    },
    async remove(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete store[key];
    },
    async clear() {
      store = {};
    },
  };
}

function buildRuntimeRecord(
  patch: {
    enabled?: boolean;
    auth?: Record<string, unknown>;
    transport?: Record<string, unknown>;
    resume?: Record<string, unknown>;
    credentials?: Record<string, unknown> | null;
    cursor?: string;
    contextTokens?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    version: 2,
    hostEpoch: "epoch-1",
    protocolVersion: HOST_PROTOCOL_VERSION,
    enabled: false,
    auth: {
      status: "logged_out",
      updatedAt: "2026-03-22T00:00:00.000Z",
      ...patch.auth,
    },
    transport: {
      status: "stopped",
      updatedAt: "2026-03-22T00:00:00.000Z",
      resumable: false,
      consecutiveFailures: 0,
      ...patch.transport,
    },
    resume: {
      resumable: false,
      ...patch.resume,
    },
    credentials: patch.credentials ?? null,
    cursor: patch.cursor || "",
    contextTokens: patch.contextTokens || {},
    sendLog: [],
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
}

async function persistRuntime(record: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set({
    [WECHAT_RUNTIME_KEY]: record,
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 1200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await vi.advanceTimersByTimeAsync(20);
  }
  throw new Error("waitFor timeout");
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
      storage: {
        local: createStorageArea(),
      },
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("getState is a pure read", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await persistRuntime(
      buildRuntimeRecord({
        enabled: true,
        auth: {
          status: "authenticated",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
        transport: {
          status: "degraded",
          resumable: true,
        },
        resume: {
          resumable: true,
        },
        credentials: {
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          userId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    const state = await service.getState();

    expect(state.auth.status).toBe("authenticated");
    expect(state.enabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("migrates legacy localStorage state into chrome.storage.local", async () => {
    localStorage.setItem(
      "bbl.wechat.host.state.v1",
      JSON.stringify({
        hostEpoch: "legacy-epoch",
        protocolVersion: HOST_PROTOCOL_VERSION,
        enabled: false,
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
      "bbl.wechat.host.credentials.v1",
      JSON.stringify({
        token: "token-1",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-1",
        userId: "bot-user",
      }),
    );

    const service = new WechatHostService();
    const state = await service.getState();
    const stored = await chrome.storage.local.get(WECHAT_RUNTIME_KEY);

    expect(state.auth.status).toBe("authenticated");
    expect(stored[WECHAT_RUNTIME_KEY]).toBeTruthy();
    expect(localStorage.getItem("bbl.wechat.host.state.v1")).toBeNull();
  });

  it("startLogin stores pending_qr state and keeps polling qr status", async () => {
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
        new Response(JSON.stringify({ status: "wait" }), { status: 200 }),
      );

    const service = new WechatHostService();
    const state = await service.startLogin();
    expect(state.auth.status).toBe("pending_qr");
    expect(state.auth.qrCode).toBe("qr-token");
    expect(state.auth.qrImageUrl).toContain("qr.png");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await service.getState()).auth.status).toBe("pending_qr");
  });

  it("resume restores polling for an authenticated session without creating a new qr", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
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
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              },
            ],
            get_updates_buf: "cursor-1",
          }),
          { status: 200 },
        ),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    await persistRuntime(
      buildRuntimeRecord({
        enabled: true,
        auth: {
          status: "authenticated",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
        transport: {
          status: "degraded",
          resumable: true,
        },
        resume: {
          resumable: true,
        },
        credentials: {
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          userId: "bot-user",
        },
      }),
    );

    const runtimeSendMessage = vi.fn(async () => ({ ok: true }));
    (globalThis as any).chrome.runtime.sendMessage = runtimeSendMessage;

    const service = new WechatHostService();
    const resumed = await service.resume("manual");
    expect(resumed.transport.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(0);
    await waitFor(async () =>
      runtimeSendMessage.mock.calls.some(
        ([message]) =>
          (message as Record<string, unknown>)?.type === "brain.channel.wechat.inbound",
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] || "")).toContain("/ilink/bot/getupdates");
    expect(String(fetchMock.mock.calls[0]?.[0] || "")).not.toContain(
      "/ilink/bot/get_bot_qrcode",
    );
    expect(runtimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.channel.wechat.inbound",
        remoteUserId: "user-2",
      }),
    );
    expect((await service.getState()).auth.status).toBe("authenticated");
  });

  it("marks transient poll failures as backing_off instead of forcing reauth", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    await persistRuntime(
      buildRuntimeRecord({
        enabled: true,
        auth: {
          status: "authenticated",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
        transport: {
          status: "degraded",
          resumable: true,
        },
        resume: {
          resumable: true,
        },
        credentials: {
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          userId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    await service.resume("manual");
    await waitFor(async () => (await service.getState()).transport.status === "backing_off");

    const state = await service.getState();
    expect(state.auth.status).toBe("authenticated");
    expect(state.transport.status).toBe("backing_off");
    expect(state.transport.nextRetryAt).toBeTruthy();
  });

  it("marks auth failures as reauth_required", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new WechatApiError("expired", {
        status: 401,
        code: -14,
      }),
    );
    await persistRuntime(
      buildRuntimeRecord({
        enabled: true,
        auth: {
          status: "authenticated",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
        transport: {
          status: "degraded",
          resumable: true,
        },
        resume: {
          resumable: true,
        },
        credentials: {
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          userId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    await service.resume("manual");
    await waitFor(async () => (await service.getState()).auth.status === "reauth_required");

    const state = await service.getState();
    expect(state.auth.status).toBe("reauth_required");
    expect(state.transport.status).toBe("stopped");
  });

  it("disable stops transport but preserves reusable auth state", async () => {
    await persistRuntime(
      buildRuntimeRecord({
        enabled: true,
        auth: {
          status: "authenticated",
          accountId: "bot-1",
          botUserId: "bot-user",
        },
        transport: {
          status: "healthy",
          resumable: true,
        },
        resume: {
          resumable: true,
        },
        credentials: {
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          accountId: "bot-1",
          userId: "bot-user",
        },
      }),
    );

    const service = new WechatHostService();
    const state = await service.disable();

    expect(state.enabled).toBe(false);
    expect(state.auth.status).toBe("authenticated");
    expect(state.transport.status).toBe("stopped");
    expect(state.resume.resumable).toBe(true);
  });
});
