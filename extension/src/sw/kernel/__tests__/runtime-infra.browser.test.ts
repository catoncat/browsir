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

async function flushMicrotasks(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
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
    await flushMicrotasks();

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

  it("keeps invoke success when response arrives before disconnect", async () => {
    const infra = createRuntimeInfraHandler();
    const connected = await infra.handleMessage({ type: "bridge.connect" });
    expect(connected?.ok).toBe(true);

    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws).toBeTruthy();
    const originalSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      originalSend(data);
      queueMicrotask(() => ws.close());
    };

    const invoked = await infra.handleMessage({
      type: "bridge.invoke",
      payload: {
        tool: "read",
        args: { path: "/tmp/response-first.txt" }
      }
    });
    expect(invoked?.ok).toBe(true);
    if (!invoked || invoked.ok !== true) return;
    const out = (invoked.data ?? {}) as Record<string, unknown>;
    const inner = (out.data ?? {}) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(inner.echoedTool).toBe("read");

    await flushMicrotasks();
  });

  it("returns E_BRIDGE_DISCONNECTED on in-flight invoke and recovers after reconnect", async () => {
    const infra = createRuntimeInfraHandler();
    const connected = await infra.handleMessage({ type: "bridge.connect" });
    expect(connected?.ok).toBe(true);

    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws).toBeTruthy();

    ws.send = (_data: string) => {
      ws.close();
    };

    const disconnectedInvoke = infra.handleMessage({
      type: "bridge.invoke",
      payload: {
        tool: "read",
        args: { path: "/tmp/disconnect.txt" }
      }
    });
    await expect(disconnectedInvoke).rejects.toMatchObject({
      message: expect.stringContaining("Bridge disconnected"),
      code: "E_BRIDGE_DISCONNECTED",
      retryable: true
    });

    const reconnected = await infra.handleMessage({ type: "bridge.connect" });
    expect(reconnected?.ok).toBe(true);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws2).not.toBe(ws);

    const recovered = await infra.handleMessage({
      type: "bridge.invoke",
      payload: {
        tool: "read",
        args: { path: "/tmp/recovered.txt" }
      }
    });
    expect(recovered?.ok).toBe(true);
    if (!recovered || recovered.ok !== true) return;
    const out = (recovered.data ?? {}) as Record<string, unknown>;
    const inner = (out.data ?? {}) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(inner.echoedTool).toBe("read");
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

  it("uses AXTree as snapshot primary path when accessibility nodes are available", async () => {
    const calls: string[] = [];
    (chrome as unknown as { debugger: any }).debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: any, method: string, params: any = {}) => {
        calls.push(method);
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              {
                nodeId: "ax-1",
                backendDOMNodeId: 101,
                role: { value: "textbox" },
                name: { value: "Editor" },
                properties: [{ name: "focusable", value: { value: true } }]
              }
            ]
          };
        }
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression || "");
          if (expression.includes("{ url: location.href, title: document.title }")) {
            return {
              result: {
                value: {
                  url: "https://example.com/editor",
                  title: "Editor"
                }
              }
            };
          }
          if (expression.includes("readyState") && expression.includes("nodeCount")) {
            return {
              result: {
                value: {
                  url: "https://example.com/editor",
                  title: "Editor",
                  readyState: "complete",
                  textLength: 18,
                  nodeCount: 4
                }
              }
            };
          }
          return { result: { value: { ok: true } } };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj-101" } };
        }
        if (method === "Runtime.callFunctionOn") {
          const fn = String(params.functionDeclaration || "");
          if (fn.includes("matchesScope")) {
            return {
              result: {
                value: {
                  ok: true,
                  matchesScope: true,
                  tag: "input",
                  role: "textbox",
                  name: "Editor",
                  value: "",
                  placeholder: "",
                  ariaLabel: "",
                  selector: "#editor",
                  disabled: false,
                  focused: false
                }
              }
            };
          }
          return { result: { value: { ok: true } } };
        }
        return {};
      },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} }
    };

    const infra = createRuntimeInfraHandler();
    const snapped = await infra.handleMessage({
      type: "cdp.snapshot",
      tabId: 11,
      options: { mode: "interactive", filter: "interactive" }
    });
    expect(snapped?.ok).toBe(true);
    if (!snapped || snapped.ok !== true) return;
    const data = (snapped.data ?? {}) as Record<string, unknown>;
    const nodes = Array.isArray(data.nodes) ? (data.nodes as Array<Record<string, unknown>>) : [];
    expect(data.source).toBe("ax");
    expect(nodes.length).toBe(1);
    expect(nodes[0].backendNodeId).toBe(101);
    expect(calls).toContain("Accessibility.getFullAXTree");
  });

  it("executes action via backendNodeId before selector fallback", async () => {
    let backendActionCalled = false;
    (chrome as unknown as { debugger: any }).debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: any, method: string, params: any = {}) => {
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              {
                nodeId: "ax-1",
                backendDOMNodeId: 301,
                role: { value: "button" },
                name: { value: "提交" },
                properties: [{ name: "focusable", value: { value: true } }]
              }
            ]
          };
        }
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression || "");
          if (expression.includes("{ url: location.href, title: document.title }")) {
            return { result: { value: { url: "https://example.com/form", title: "Form" } } };
          }
          if (expression.includes("readyState") && expression.includes("nodeCount")) {
            return {
              result: {
                value: {
                  url: "https://example.com/form",
                  title: "Form",
                  readyState: "complete",
                  textLength: 10,
                  nodeCount: 3
                }
              }
            };
          }
          return { result: { value: { ok: true } } };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj-301" } };
        }
        if (method === "Runtime.callFunctionOn") {
          const fn = String(params.functionDeclaration || "");
          if (fn.includes("matchesScope")) {
            return {
              result: {
                value: {
                  ok: true,
                  matchesScope: true,
                  tag: "button",
                  role: "button",
                  name: "提交",
                  value: "",
                  placeholder: "",
                  ariaLabel: "",
                  selector: "#submit",
                  disabled: false,
                  focused: false
                }
              }
            };
          }
          if (fn.includes("backend-node")) {
            backendActionCalled = true;
            return {
              result: {
                value: {
                  ok: true,
                  clicked: true,
                  via: "backend-node",
                  url: "https://example.com/form",
                  title: "Form"
                }
              }
            };
          }
          return { result: { value: { ok: true } } };
        }
        if (method === "Runtime.releaseObject") return {};
        return {};
      },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} }
    };

    const infra = createRuntimeInfraHandler();
    const snapped = await infra.handleMessage({
      type: "cdp.snapshot",
      tabId: 21,
      options: { mode: "interactive" }
    });
    expect(snapped?.ok).toBe(true);

    const acquired = await infra.handleMessage({
      type: "lease.acquire",
      tabId: 21,
      owner: "runner-ax"
    });
    expect(acquired?.ok).toBe(true);

    const acted = await infra.handleMessage({
      type: "cdp.action",
      tabId: 21,
      owner: "runner-ax",
      action: {
        kind: "click",
        ref: "e0"
      }
    });
    expect(acted?.ok).toBe(true);
    if (!acted || acted.ok !== true) return;
    const data = (acted.data ?? {}) as Record<string, unknown>;
    const result = (data.result ?? {}) as Record<string, unknown>;
    expect(result.via).toBe("backend-node");
    expect(backendActionCalled).toBe(true);
  });

  it("includes frameId in AXTree snapshot nodes when frame trees are available", async () => {
    (chrome as unknown as { debugger: any }).debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: any, method: string, params: any = {}) => {
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: "main-frame" },
              childFrames: [
                {
                  frame: { id: "child-frame-1" }
                }
              ]
            }
          };
        }
        if (method === "Accessibility.getFullAXTree") {
          if (params.frameId === "main-frame") {
            return {
              nodes: [
                {
                  nodeId: "ax-main-1",
                  backendDOMNodeId: 401,
                  role: { value: "textbox" },
                  name: { value: "Main Input" },
                  properties: [{ name: "focusable", value: { value: true } }]
                }
              ]
            };
          }
          if (params.frameId === "child-frame-1") {
            return {
              nodes: [
                {
                  nodeId: "ax-child-1",
                  backendDOMNodeId: 402,
                  role: { value: "button" },
                  name: { value: "Child Submit" },
                  properties: [{ name: "focusable", value: { value: true } }]
                }
              ]
            };
          }
          return { nodes: [] };
        }
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression || "");
          if (expression.includes("{ url: location.href, title: document.title }")) {
            return { result: { value: { url: "https://example.com/frame", title: "Frame Demo" } } };
          }
          if (expression.includes("readyState") && expression.includes("nodeCount")) {
            return {
              result: {
                value: {
                  url: "https://example.com/frame",
                  title: "Frame Demo",
                  readyState: "complete",
                  textLength: 22,
                  nodeCount: 8
                }
              }
            };
          }
          return { result: { value: { ok: true } } };
        }
        if (method === "DOM.resolveNode") {
          const backendNodeId = Number(params.backendNodeId || 0);
          return { object: { objectId: `obj-${backendNodeId}` } };
        }
        if (method === "Runtime.callFunctionOn") {
          const fn = String(params.functionDeclaration || "");
          if (fn.includes("matchesScope")) {
            const objectId = String(params.objectId || "");
            if (objectId.includes("401")) {
              return {
                result: {
                  value: {
                    ok: true,
                    matchesScope: true,
                    tag: "input",
                    role: "textbox",
                    name: "Main Input",
                    value: "",
                    placeholder: "",
                    ariaLabel: "",
                    selector: "#main-input",
                    disabled: false,
                    focused: false
                  }
                }
              };
            }
            return {
              result: {
                value: {
                  ok: true,
                  matchesScope: true,
                  tag: "button",
                  role: "button",
                  name: "Child Submit",
                  value: "",
                  placeholder: "",
                  ariaLabel: "",
                  selector: "#child-submit",
                  disabled: false,
                  focused: false
                }
              }
            };
          }
          return { result: { value: { ok: true } } };
        }
        if (method === "Runtime.releaseObject") return {};
        return {};
      },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} }
    };

    const infra = createRuntimeInfraHandler();
    const snapped = await infra.handleMessage({
      type: "cdp.snapshot",
      tabId: 31,
      options: { mode: "interactive" }
    });
    expect(snapped?.ok).toBe(true);
    if (!snapped || snapped.ok !== true) return;
    const data = (snapped.data ?? {}) as Record<string, unknown>;
    const nodes = Array.isArray(data.nodes) ? (data.nodes as Array<Record<string, unknown>>) : [];
    expect(data.source).toBe("ax");
    expect(nodes.length).toBe(2);
    const frameIds = nodes.map((node) => String(node.frameId || ""));
    expect(frameIds).toContain("main-frame");
    expect(frameIds).toContain("child-frame-1");
  });

  it("polls verify within time window until selector condition becomes true", async () => {
    let selectorChecks = 0;
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
                  url: "https://example.com/polling",
                  title: "Polling",
                  readyState: "complete",
                  textLength: 12,
                  nodeCount: 3
                }
              }
            };
          }
          if (expression.includes("existsIn(document)")) {
            selectorChecks += 1;
            return {
              result: {
                value: selectorChecks >= 2
              }
            };
          }
          return { result: { value: { ok: true } } };
        }
        return {};
      },
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} }
    };

    const infra = createRuntimeInfraHandler();
    const verified = await infra.handleMessage({
      type: "cdp.verify",
      tabId: 41,
      action: {
        expect: {
          selectorExists: "#ready",
          waitForMs: 500,
          pollIntervalMs: 10
        }
      }
    });
    expect(verified?.ok).toBe(true);
    if (!verified || verified.ok !== true) return;
    const verifyData = (verified.data ?? {}) as Record<string, unknown>;
    expect(verifyData.ok).toBe(true);
    expect(Number(verifyData.attempts || 0)).toBeGreaterThan(1);
    expect(selectorChecks).toBeGreaterThanOrEqual(2);
  });
});
