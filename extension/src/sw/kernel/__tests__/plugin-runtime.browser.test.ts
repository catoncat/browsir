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

  it("拒绝未授权 capability provider", () => {
    const orchestrator = new BrainOrchestrator();

    expect(() =>
      orchestrator.registerPlugin({
        manifest: {
          id: "plugin.no-capability-provider-permission",
          name: "no-capability-provider",
          version: "1.0.0",
          permissions: {
            capabilities: []
          }
        },
        providers: {
          capabilities: {
            "fs.virtual.read": {
              id: "plugin.no-capability-provider.read",
              mode: "bridge",
              invoke: async () => ({ ok: true })
            }
          }
        }
      })
    ).toThrow("未授权 capability provider");
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

    orchestrator.disablePlugin("plugin.virtual-fs");
    const disabledResult = await orchestrator.executeStep({
      sessionId,
      capability: "fs.virtual.read",
      action: "read_file",
      args: { path: "mem://notes.md" },
      verifyPolicy: "off"
    });
    expect(disabledResult.ok).toBe(false);
    expect(String(disabledResult.error || "")).toContain("未找到 capability provider");
  });

  it("支持 capability policy 覆盖并在 disable 后回滚", () => {
    const orchestrator = new BrainOrchestrator();
    const before = orchestrator.resolveCapabilityPolicy("browser.action");
    expect(before.defaultVerifyPolicy).toBe("on_critical");
    expect(before.allowScriptFallback).toBe(true);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.policy.override",
        name: "policy-override",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"]
        }
      },
      policies: {
        capabilities: {
          "browser.action": {
            defaultVerifyPolicy: "always",
            leasePolicy: "required",
            allowScriptFallback: false
          }
        }
      }
    });

    const applied = orchestrator.resolveCapabilityPolicy("browser.action");
    expect(applied.defaultVerifyPolicy).toBe("always");
    expect(applied.leasePolicy).toBe("required");
    expect(applied.allowScriptFallback).toBe(false);

    orchestrator.disablePlugin("plugin.policy.override");

    const rolledBack = orchestrator.resolveCapabilityPolicy("browser.action");
    expect(rolledBack.defaultVerifyPolicy).toBe("on_critical");
    expect(rolledBack.leasePolicy).toBe("auto");
    expect(rolledBack.allowScriptFallback).toBe(true);
  });

  it("replaceProviders=true 时 disable 会恢复被替换 provider 与 policy", async () => {
    const orchestrator = new BrainOrchestrator();
    const { sessionId } = await orchestrator.createSession({ title: "plugin-restore-replaced" });

    orchestrator.registerToolProvider(
      "script",
      {
        id: "base.script",
        invoke: async () => ({ source: "base-script" })
      },
      { replace: true }
    );
    orchestrator.registerCapabilityPolicy(
      "browser.action",
      {
        defaultVerifyPolicy: "always",
        leasePolicy: "required"
      },
      {
        replace: true,
        id: "base:browser.action"
      }
    );

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.replace-all",
        name: "replace-all",
        version: "1.0.0",
        permissions: {
          modes: ["script"],
          capabilities: ["browser.action"],
          replaceProviders: true
        }
      },
      providers: {
        modes: {
          script: {
            id: "plugin.replace-all.script",
            invoke: async () => ({ source: "plugin-script" })
          }
        }
      },
      policies: {
        capabilities: {
          "browser.action": {
            defaultVerifyPolicy: "off",
            leasePolicy: "none"
          }
        }
      }
    });

    const enabled = await orchestrator.executeStep({
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off"
    });
    expect(enabled.ok).toBe(true);
    expect(enabled.data).toEqual({ source: "plugin-script" });
    expect(orchestrator.resolveCapabilityPolicy("browser.action").defaultVerifyPolicy).toBe("off");

    orchestrator.disablePlugin("plugin.replace-all");

    const restored = await orchestrator.executeStep({
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off"
    });
    expect(restored.ok).toBe(true);
    expect(restored.data).toEqual({ source: "base-script" });
    const restoredPolicy = orchestrator.resolveCapabilityPolicy("browser.action");
    expect(restoredPolicy.defaultVerifyPolicy).toBe("always");
    expect(restoredPolicy.leasePolicy).toBe("required");
  });

  it("hook id 同名时，禁用单个插件不会误删其他插件 hook", async () => {
    const orchestrator = new BrainOrchestrator(
      {},
      {
        script: async () => ({ source: "script" })
      }
    );
    const { sessionId } = await orchestrator.createSession({ title: "plugin-hook-id-scope" });

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.hook.a",
        name: "hook-a",
        version: "1.0.0",
        permissions: { hooks: ["tool.after_result"] }
      },
      hooks: {
        "tool.after_result": {
          handler: () => ({ action: "patch", patch: { result: { source: "A" } } }),
          options: { id: "shared-hook-id" }
        }
      }
    });
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.hook.b",
        name: "hook-b",
        version: "1.0.0",
        permissions: { hooks: ["tool.after_result"] }
      },
      hooks: {
        "tool.after_result": {
          handler: () => ({ action: "patch", patch: { result: { source: "B" } } }),
          options: { id: "shared-hook-id" }
        }
      }
    });

    const beforeDisable = await orchestrator.executeStep({
      sessionId,
      mode: "script",
      action: "click"
    });
    expect(beforeDisable.ok).toBe(true);
    expect(beforeDisable.data).toEqual({ source: "B" });

    orchestrator.disablePlugin("plugin.hook.a");

    const afterDisable = await orchestrator.executeStep({
      sessionId,
      mode: "script",
      action: "click"
    });
    expect(afterDisable.ok).toBe(true);
    expect(afterDisable.data).toEqual({ source: "B" });
  });
});
