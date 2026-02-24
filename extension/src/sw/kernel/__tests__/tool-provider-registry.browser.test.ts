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
      action: "read_file",
      args: { targetUri: "local:///tmp/a.txt" }
    });
    expect(local.providerId).toBe("provider.local");
    expect(local.data).toEqual({ source: "local" });

    const workspace = await registry.invoke("bridge", {
      sessionId: "s-workspace",
      capability: "fs.virtual.read",
      action: "read_file",
      args: { targetUri: "workspace://docs/a.txt" }
    });
    expect(workspace.providerId).toBe("provider.workspace");
    expect(workspace.data).toEqual({ source: "workspace" });

    await expect(
      registry.invoke("bridge", {
        sessionId: "s-none",
        capability: "fs.virtual.read",
        action: "read_file",
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
});
