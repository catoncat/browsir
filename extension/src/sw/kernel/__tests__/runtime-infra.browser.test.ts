import "./test-setup";

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createRuntimeInfraHandler } from "../runtime-infra.browser";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static nextError: Record<string, unknown> | null = null;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({ type: "open" } as Event);
    });
  }

  send(data: string): void {
    const payload = JSON.parse(data) as { id: string; tool?: string };
    const pendingError = FakeWebSocket.nextError;
    FakeWebSocket.nextError = null;
    queueMicrotask(() => {
      if (pendingError) {
        this.onmessage?.({
          data: JSON.stringify({
            id: payload.id,
            ok: false,
            error: pendingError
          })
        } as MessageEvent<string>);
        return;
      }
      this.onmessage?.({
        data: JSON.stringify({
          id: payload.id,
          ok: true,
          data: { echoedTool: payload.tool || "" }
        })
      } as MessageEvent<string>);
    });
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({
      code: 1000,
      reason: "closed",
      wasClean: true
    } as CloseEvent);
  }
}

describe("runtime infra handler", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.nextError = null;
    // vitest 环境下 bridge 不需要真实网络。
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    (chrome as unknown as { debugger: any }).debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: any, method: string, params: any = {}) => {
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression || "");
          if (expression.includes("readyState") && expression.includes("nodeCount")) {
            return {
              result: {
                value: {
                  url: "https://example.com/page",
                  title: "Example",
                  readyState: "complete",
                  textLength: 120,
                  nodeCount: 12
                }
              }
            };
          }
          if (expression.includes("nodes") && expression.includes("selector not found")) {
            return {
              result: {
                value: {
                  ok: true,
                  url: "https://example.com/page",
                  title: "Example",
                  nodes: [
                    {
                      role: "button",
                      name: "提交",
                      value: "",
                      selector: "#submit",
                      disabled: false,
                      focused: false,
                      tag: "button"
                    }
                  ]
                }
              }
            };
          }
          if (expression.includes("document.body?.innerText")) {
            return {
              result: {
                value: "example body text"
              }
            };
          }
          if (expression.includes("document.querySelector")) {
            return {
              result: {
                value: true
              }
            };
          }
          return {
            result: {
              value: {
                ok: true,
                clicked: true,
                url: "https://example.com/page",
                title: "Example"
              }
            }
          };
        }

        if (method === "Page.navigate") {
          return { frameId: "frame-1" };
        }

        return {};
      },
      onEvent: {
        addListener: () => {}
      },
      onDetach: {
        addListener: () => {}
      }
    };
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  });

  it("supports config.get + config.save roundtrip", async () => {
    const infra = createRuntimeInfraHandler();

    const first = await infra.handleMessage({ type: "config.get" });
    expect(first?.ok).toBe(true);
    if (!first || first.ok !== true) return;
    const initial = (first.data ?? {}) as Record<string, unknown>;
    expect(String(initial.bridgeUrl || "")).toContain("ws://");

    const saved = await infra.handleMessage({
      type: "config.save",
      payload: {
        bridgeUrl: "ws://127.0.0.1:18787/ws",
        bridgeToken: "token-x",
        llmApiBase: "https://example.com/v1",
        llmApiKey: "k1",
        llmModel: "gpt-test",
        autoTitleInterval: 7,
        bridgeInvokeTimeoutMs: 180000,
        llmTimeoutMs: 175000,
        llmRetryMaxAttempts: 4,
        llmMaxRetryDelayMs: 45000
      }
    });
    expect(saved?.ok).toBe(true);

    const after = await infra.handleMessage({ type: "config.get" });
    expect(after?.ok).toBe(true);
    if (!after || after.ok !== true) return;
    const updated = (after.data ?? {}) as Record<string, unknown>;
    expect(updated.bridgeUrl).toBe("ws://127.0.0.1:18787/ws");
    expect(updated.bridgeToken).toBe("token-x");
    expect(updated.llmModel).toBe("gpt-test");
    expect(updated.autoTitleInterval).toBe(7);
    expect(updated.bridgeInvokeTimeoutMs).toBe(180000);
    expect(updated.llmTimeoutMs).toBe(175000);
    expect(updated.llmRetryMaxAttempts).toBe(4);
    expect(updated.llmMaxRetryDelayMs).toBe(45000);
  });

  it("supports lease acquire/heartbeat/release contract", async () => {
    const infra = createRuntimeInfraHandler();
    const tabId = 101;

    const acquired = await infra.handleMessage({
      type: "lease.acquire",
      tabId,
      owner: "owner-a",
      ttlMs: 5000
    });
    expect(acquired?.ok).toBe(true);
    if (!acquired || acquired.ok !== true) return;
    const acquireData = (acquired.data ?? {}) as Record<string, unknown>;
    expect((acquireData.ok as boolean) ?? false).toBe(true);

    const conflict = await infra.handleMessage({
      type: "lease.acquire",
      tabId,
      owner: "owner-b"
    });
    expect(conflict?.ok).toBe(true);
    if (!conflict || conflict.ok !== true) return;
    const conflictData = (conflict.data ?? {}) as Record<string, unknown>;
    expect(conflictData.ok).toBe(false);
    expect(conflictData.reason).toBe("locked_by_other");

    const heartbeat = await infra.handleMessage({
      type: "lease.heartbeat",
      tabId,
      owner: "owner-a",
      ttlMs: 7000
    });
    expect(heartbeat?.ok).toBe(true);
    if (!heartbeat || heartbeat.ok !== true) return;
    const heartbeatData = (heartbeat.data ?? {}) as Record<string, unknown>;
    expect(heartbeatData.ok).toBe(true);

    const released = await infra.handleMessage({
      type: "lease.release",
      tabId,
      owner: "owner-a"
    });
    expect(released?.ok).toBe(true);
    if (!released || released.ok !== true) return;
    const releasedData = (released.data ?? {}) as Record<string, unknown>;
    expect(releasedData.ok).toBe(true);
    expect(releasedData.released).toBe(true);
  });

  it("supports bridge.connect + bridge.invoke with websocket response", async () => {
    const infra = createRuntimeInfraHandler();

    const connect = await infra.handleMessage({ type: "bridge.connect" });
    expect(connect?.ok).toBe(true);

    const invoked = await infra.handleMessage({
      type: "bridge.invoke",
      payload: {
        tool: "read",
        args: { path: "/tmp/demo.txt" }
      }
    });
    expect(invoked?.ok).toBe(true);
    if (!invoked || invoked.ok !== true) return;
    const invokeData = (invoked.data ?? {}) as Record<string, unknown>;
    const innerData = ((invokeData.data as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    expect(invokeData.ok).toBe(true);
    expect(innerData.echoedTool).toBe("read");
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
  });

  it("broadcasts bridge.status on connect/disconnect", async () => {
    const sent: Array<Record<string, unknown>> = [];
    (chrome as unknown as { runtime: { sendMessage: (message: Record<string, unknown>) => Promise<unknown> } }).runtime.sendMessage =
      async (message: Record<string, unknown>) => {
        sent.push(message);
        return { ok: true };
      };

    const infra = createRuntimeInfraHandler();
    const connect = await infra.handleMessage({ type: "bridge.connect" });
    expect(connect?.ok).toBe(true);
    expect(sent.some((item) => item.type === "bridge.status" && item.status === "connected")).toBe(true);

    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws).toBeTruthy();
    ws?.close();
    await Promise.resolve();

    expect(sent.some((item) => item.type === "bridge.status" && item.status === "disconnected")).toBe(true);
  });

  it("propagates bridge invoke error code/details", async () => {
    const infra = createRuntimeInfraHandler();
    const connect = await infra.handleMessage({ type: "bridge.connect" });
    expect(connect?.ok).toBe(true);

    FakeWebSocket.nextError = {
      code: "E_BUSY",
      message: "Bridge concurrency limit reached",
      details: {
        maxConcurrency: 1
      }
    };

    await expect(
      infra.handleMessage({
        type: "bridge.invoke",
        payload: {
          tool: "read",
          args: { path: "/tmp/demo.txt" }
        }
      })
    ).rejects.toMatchObject({
      message: "Bridge concurrency limit reached",
      code: "E_BUSY",
      retryable: true
    });
  });

  it("supports cdp.observe/snapshot/action/verify with lease guard", async () => {
    const infra = createRuntimeInfraHandler();
    const tabId = 7;

    const observed = await infra.handleMessage({ type: "cdp.observe", tabId });
    expect(observed?.ok).toBe(true);
    if (!observed || observed.ok !== true) return;
    const observedData = (observed.data ?? {}) as Record<string, unknown>;
    const observedPage = (observedData.page ?? {}) as Record<string, unknown>;
    expect(observedPage.url).toBe("https://example.com/page");

    const snapped = await infra.handleMessage({
      type: "cdp.snapshot",
      tabId,
      options: {
        mode: "interactive",
        filter: "interactive"
      }
    });
    expect(snapped?.ok).toBe(true);
    if (!snapped || snapped.ok !== true) return;
    const snapData = (snapped.data ?? {}) as Record<string, unknown>;
    const nodes = Array.isArray(snapData.nodes) ? (snapData.nodes as Array<Record<string, unknown>>) : [];
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0].ref).toBe("e0");

    const acquired = await infra.handleMessage({
      type: "lease.acquire",
      tabId,
      owner: "runner-1"
    });
    expect(acquired?.ok).toBe(true);

    const acted = await infra.handleMessage({
      type: "cdp.action",
      tabId,
      owner: "runner-1",
      action: {
        kind: "click",
        ref: "e0"
      }
    });
    expect(acted?.ok).toBe(true);

    const verified = await infra.handleMessage({
      type: "cdp.verify",
      tabId,
      action: {
        expect: {
          urlContains: "example.com"
        }
      }
    });
    expect(verified?.ok).toBe(true);
    if (!verified || verified.ok !== true) return;
    const verifyData = (verified.data ?? {}) as Record<string, unknown>;
    expect(verifyData.ok).toBe(true);
  });
});
