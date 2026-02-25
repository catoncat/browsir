import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { getDB } from "../idb-storage";
import { BrainOrchestrator } from "../orchestrator.browser";
import { createRuntimeLoopController } from "../runtime-loop.browser";
import type { RuntimeInfraHandler, RuntimeInfraResult } from "../runtime-infra.browser";

type InfraCall = Record<string, unknown>;

function createMockInfra() {
  const calls: InfraCall[] = [];

  const infra: RuntimeInfraHandler = {
    async handleMessage(message: unknown): Promise<RuntimeInfraResult | null> {
      const msg = (message || {}) as Record<string, unknown>;
      calls.push(msg);

      if (String(msg.type || "") === "bridge.invoke") {
        const payload = ((msg.payload || {}) as Record<string, unknown>) || {};
        const tool = String(payload.tool || "");
        const args = ((payload.args || {}) as Record<string, unknown>) || {};

        if (tool === "read") {
          return {
            ok: true,
            data: {
              ok: true,
              data: {
                path: String(args.path || ""),
                content: `local:${String(args.path || "")}`
              }
            }
          };
        }

        return {
          ok: true,
          data: {
            ok: true,
            data: {
              tool,
              args
            }
          }
        };
      }

      return { ok: true, data: {} };
    },
    disconnectBridge() {},
    abortBridgeInvokesBySession() {
      return 0;
    }
  };

  return { infra, calls };
}

async function clearKvStore() {
  const db = await getDB();
  await db.clear("kv");
}

describe("runtime-loop routing (bridge vs browser-vfs)", () => {
  beforeEach(async () => {
    await clearKvStore();
  });

  it("routes mem:// file operations to browser vfs by default", async () => {
    const orchestrator = new BrainOrchestrator();
    const mock = createMockInfra();
    createRuntimeLoopController(orchestrator, mock.infra);

    const wrote = await orchestrator.executeStep({
      sessionId: "s-vfs-default",
      capability: "fs.write",
      action: "invoke",
      args: {
        frame: {
          tool: "write",
          args: {
            path: "mem://notes/demo.txt",
            content: "hello-vfs",
            mode: "overwrite"
          }
        }
      },
      verifyPolicy: "off"
    });

    expect(wrote.ok).toBe(true);
    expect(mock.calls.some((item) => String(item.type || "") === "bridge.invoke")).toBe(false);

    const readBack = await orchestrator.executeStep({
      sessionId: "s-vfs-default",
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://notes/demo.txt"
          }
        }
      },
      verifyPolicy: "off"
    });

    expect(readBack.ok).toBe(true);
    const readData = (readBack.data || {}) as Record<string, unknown>;
    const response = (readData.response || {}) as Record<string, unknown>;
    const payload = (response.data || {}) as Record<string, unknown>;
    expect(String(payload.content || "")).toBe("hello-vfs");

    const localRead = await orchestrator.executeStep({
      sessionId: "s-vfs-default",
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "/tmp/local-read.txt"
          }
        }
      },
      verifyPolicy: "off"
    });

    expect(localRead.ok).toBe(true);
    const localBridgeCalls = mock.calls.filter((item) => String(item.type || "") === "bridge.invoke");
    expect(localBridgeCalls.length).toBe(1);
    const localPayload = (localBridgeCalls[0].payload || {}) as Record<string, unknown>;
    expect(String(localPayload.tool || "")).toBe("read");
    expect(String((((localPayload.args || {}) as Record<string, unknown>).path) || "")).toBe("/tmp/local-read.txt");
  });

  it("honors runtime hint override when choosing bridge or browser vfs", async () => {
    const orchestrator = new BrainOrchestrator();
    const mock = createMockInfra();
    createRuntimeLoopController(orchestrator, mock.infra);

    const forcedLocal = await orchestrator.executeStep({
      sessionId: "s-vfs-runtime-hint",
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://notes/forced-local.txt",
            runtime: "local"
          }
        }
      },
      verifyPolicy: "off"
    });

    expect(forcedLocal.ok).toBe(true);
    const bridgeCallsAfterForcedLocal = mock.calls.filter((item) => String(item.type || "") === "bridge.invoke");
    expect(bridgeCallsAfterForcedLocal.length).toBe(1);
    const forcedLocalPayload = (bridgeCallsAfterForcedLocal[0].payload || {}) as Record<string, unknown>;
    expect(String(((forcedLocalPayload.args || {}) as Record<string, unknown>).runtime || "")).toBe("local");

    mock.calls.length = 0;

    const forcedBrowser = await orchestrator.executeStep({
      sessionId: "s-vfs-runtime-hint",
      capability: "fs.write",
      action: "invoke",
      args: {
        frame: {
          tool: "write",
          args: {
            path: "/tmp/forced-browser.txt",
            runtime: "browser",
            content: "from-browser-runtime",
            mode: "overwrite"
          }
        }
      },
      verifyPolicy: "off"
    });

    expect(forcedBrowser.ok).toBe(true);
    expect(mock.calls.some((item) => String(item.type || "") === "bridge.invoke")).toBe(false);

    const readForcedBrowser = await orchestrator.executeStep({
      sessionId: "s-vfs-runtime-hint",
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://tmp/forced-browser.txt"
          }
        }
      },
      verifyPolicy: "off"
    });

    expect(readForcedBrowser.ok).toBe(true);
    const forcedBrowserData = (readForcedBrowser.data || {}) as Record<string, unknown>;
    const forcedBrowserResponse = (forcedBrowserData.response || {}) as Record<string, unknown>;
    const forcedBrowserPayload = (forcedBrowserResponse.data || {}) as Record<string, unknown>;
    expect(String(forcedBrowserPayload.content || "")).toBe("from-browser-runtime");
  });
});
