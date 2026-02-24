import "./test-setup";

import { describe, expect, it } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";

describe("plugin-runtime.browser", () => {
  it("拒绝未授权 hook", () => {
    const orchestrator = new BrainOrchestrator();

    expect(() =>
      orchestrator.registerPlugin({
        manifest: {
          id: "plugin.no-hook-permission",
          name: "no-hook",
          version: "1.0.0",
          permissions: { hooks: [] }
        },
        hooks: {
          "tool.before_call": () => ({ action: "continue" })
        }
      })
    ).toThrow("未授权 hook");
  });

  it("支持插件 enable/disable 生命周期", async () => {
    const orchestrator = new BrainOrchestrator(
      {},
      {
        script: async () => ({ source: "script" })
      }
    );
    const { sessionId } = await orchestrator.createSession({ title: "plugin-lifecycle" });

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.patch-result",
        name: "patch-result",
        version: "1.0.0",
        permissions: { hooks: ["tool.after_result"] }
      },
      hooks: {
        "tool.after_result": () => ({
          action: "patch",
          patch: {
            result: { source: "plugin" }
          }
        })
      }
    });

    const enabled = await orchestrator.executeStep({
      sessionId,
      mode: "script",
      action: "click"
    });
    expect(enabled.ok).toBe(true);
    expect(enabled.data).toEqual({ source: "plugin" });

    orchestrator.disablePlugin("plugin.patch-result");

    const disabled = await orchestrator.executeStep({
      sessionId,
      mode: "script",
      action: "click"
    });
    expect(disabled.ok).toBe(true);
    expect(disabled.data).toEqual({ source: "script" });
  });

  it("支持 capability provider，不绑定本机 mode", async () => {
    const orchestrator = new BrainOrchestrator();
    const { sessionId } = await orchestrator.createSession({ title: "capability-provider" });

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.virtual-fs",
        name: "virtual-fs",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.virtual.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.virtual-fs.read",
            mode: "bridge",
            invoke: async (input) => ({
              provider: "virtual-fs",
              mode: input.mode,
              path: String(input.args?.path || "")
            })
          }
        }
      }
    });

    const result = await orchestrator.executeStep({
      sessionId,
      capability: "fs.virtual.read",
      action: "read_file",
      args: { path: "mem://notes.md" },
      verifyPolicy: "off"
    });

    expect(result.ok).toBe(true);
    expect(result.modeUsed).toBe("bridge");
    expect(result.capabilityUsed).toBe("fs.virtual.read");
    expect(result.data).toEqual({
      provider: "virtual-fs",
      mode: "bridge",
      path: "mem://notes.md"
    });
  });
});
