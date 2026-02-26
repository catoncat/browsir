import { describe, expect, it } from "vitest";
import { ToolProviderRegistry } from "../tool-provider-registry";

describe("tool-provider-registry.browser", () => {
  it("supports multiple providers for same capability and sorts by priority", () => {
    const registry = new ToolProviderRegistry();
    registry.registerCapability("fs.virtual.read", {
      id: "provider.low",
      mode: "bridge",
      priority: 1,
      invoke: async () => ({ source: "low" })
    });
    registry.registerCapability("fs.virtual.read", {
      id: "provider.high",
      mode: "bridge",
      priority: 9,
      invoke: async () => ({ source: "high" })
    });

    const listed = registry
      .listCapabilities()
      .filter((item) => item.capability === "fs.virtual.read")
      .map((item) => item.id);
    expect(listed).toEqual(["provider.high", "provider.low"]);
    expect(registry.getCapability("fs.virtual.read")?.id).toBe("provider.high");
  });

  it("routes by canHandle when capability has multiple providers", async () => {
    const registry = new ToolProviderRegistry();
    registry.registerCapability("fs.virtual.read", {
      id: "provider.workspace",
      mode: "bridge",
      priority: 20,
      canHandle: (input) => String(input.args?.targetUri || "").startsWith("workspace://"),
      invoke: async () => ({ source: "workspace" })
    });
    registry.registerCapability("fs.virtual.read", {
      id: "provider.local",
      mode: "bridge",
      priority: 10,
      canHandle: (input) => String(input.args?.targetUri || "").startsWith("local://"),
      invoke: async () => ({ source: "local" })
    });

    const local = await registry.invoke("bridge", {
      sessionId: "s-local",
      capability: "fs.virtual.read",
      action: "browser_read_file",
      args: { targetUri: "local:///tmp/a.txt" }
    });
    expect(local.providerId).toBe("provider.local");
    expect(local.data).toEqual({ source: "local" });

    const workspace = await registry.invoke("bridge", {
      sessionId: "s-workspace",
      capability: "fs.virtual.read",
      action: "browser_read_file",
      args: { targetUri: "workspace://docs/a.txt" }
    });
    expect(workspace.providerId).toBe("provider.workspace");
    expect(workspace.data).toEqual({ source: "workspace" });

    await expect(
      registry.invoke("bridge", {
        sessionId: "s-none",
        capability: "fs.virtual.read",
        action: "browser_read_file",
        args: { targetUri: "plugin://pkg/data.txt" }
      })
    ).rejects.toThrow("未找到 capability provider");
  });

  it("supports unregistering one provider by id", () => {
    const registry = new ToolProviderRegistry();
    registry.registerCapability("fs.virtual.read", {
      id: "provider.a",
      mode: "bridge",
      invoke: async () => ({ source: "A" })
    });
    registry.registerCapability("fs.virtual.read", {
      id: "provider.b",
      mode: "bridge",
      invoke: async () => ({ source: "B" })
    });

    expect(registry.unregisterCapability("fs.virtual.read", "provider.a")).toBe(true);
    expect(registry.getCapabilities("fs.virtual.read").map((item) => item.id)).toEqual(["provider.b"]);
    expect(registry.unregisterCapability("fs.virtual.read", "provider.unknown")).toBe(false);
    expect(registry.unregisterCapability("fs.virtual.read", "provider.b")).toBe(true);
    expect(registry.hasCapability("fs.virtual.read")).toBe(false);
  });

  it("replace=true clears previous capability providers", () => {
    const registry = new ToolProviderRegistry();
    registry.registerCapability("fs.virtual.read", {
      id: "provider.a",
      mode: "bridge",
      invoke: async () => ({ source: "A" })
    });
    registry.registerCapability("fs.virtual.read", {
      id: "provider.b",
      mode: "bridge",
      invoke: async () => ({ source: "B" })
    });

    registry.registerCapability(
      "fs.virtual.read",
      {
        id: "provider.c",
        mode: "bridge",
        invoke: async () => ({ source: "C" })
      },
      { replace: true }
    );

    expect(registry.getCapabilities("fs.virtual.read").map((item) => item.id)).toEqual(["provider.c"]);
  });

  it("falls back to capability default provider when strict mode hint has no match", async () => {
    const registry = new ToolProviderRegistry();
    registry.registerCapability("browser.action", {
      id: "provider.script",
      mode: "script",
      priority: 20,
      canHandle: async (input) => String(input.args?.target || "").includes("script"),
      invoke: async () => ({ source: "script" })
    });
    registry.registerCapability("browser.action", {
      id: "provider.cdp",
      mode: "cdp",
      priority: 10,
      canHandle: async () => true,
      invoke: async () => ({ source: "cdp" })
    });

    const routed = await registry.invoke("script", {
      sessionId: "s-route",
      capability: "browser.action",
      action: "click",
      args: { target: "button#submit" }
    });

    expect(routed.providerId).toBe("provider.cdp");
    expect(routed.modeUsed).toBe("cdp");
    expect(routed.data).toEqual({ source: "cdp" });
  });

  it("resolveMode keeps explicit mode when mode and capability are both provided", () => {
    const registry = new ToolProviderRegistry();
    registry.registerCapability("browser.action", {
      id: "provider.browser",
      mode: "cdp",
      invoke: async () => ({ ok: true })
    });

    expect(
      registry.resolveMode({
        sessionId: "s-explicit",
        mode: "script",
        capability: "browser.action",
        action: "click",
        args: {}
      })
    ).toBe("script");

    expect(
      registry.resolveMode({
        sessionId: "s-capability-only",
        capability: "browser.action",
        action: "click",
        args: {}
      })
    ).toBe("cdp");
  });

  it("attaches mode and capability metadata when capability provider throws", async () => {
    const registry = new ToolProviderRegistry();
    registry.registerCapability("browser.verify", {
      id: "provider.verify",
      mode: "cdp",
      invoke: async () => {
        throw new Error("verify failed");
      }
    });

    let thrown: unknown;
    try {
      await registry.invoke("cdp", {
        sessionId: "s-error-meta",
        capability: "browser.verify",
        action: "assert_text",
        args: { expected: "Done" }
      });
    } catch (error) {
      thrown = error;
    }

    const runtimeError = thrown as Error & { modeUsed?: string; capabilityUsed?: string };
    expect(runtimeError).toBeInstanceOf(Error);
    expect(runtimeError.message).toContain("verify failed");
    expect(runtimeError.modeUsed).toBe("cdp");
    expect(runtimeError.capabilityUsed).toBe("browser.verify");
  });
});
