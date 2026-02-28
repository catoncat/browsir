import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPanelUiPluginRuntime } from "../ui-plugin-runtime";

describe("panel ui plugin runtime remote mem hooks", () => {
  beforeEach(() => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        hookResult: {
          action: "patch",
          patch: {
            message: "发送成功!"
          }
        }
      }
    });
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage
      }
    };
  });

  it("routes mem:// descriptor hook through brain.plugin.ui_hook.run", async () => {
    const runtime = createPanelUiPluginRuntime({ defaultTimeoutMs: 120 });
    await runtime.hydrate([
      {
        pluginId: "plugin.test.ui.mem",
        moduleUrl: "mem://plugins/plugin.test.ui.mem/ui.js",
        exportName: "default",
        enabled: true,
        sessionId: "plugin-studio"
      }
    ]);

    const result = await runtime.runHook("ui.notice.before_show", {
      type: "success",
      message: "发送成功"
    });

    expect(result.blocked).toBe(false);
    expect(result.value.message).toBe("发送成功!");

    const chromeLike = (globalThis as Record<string, unknown>).chrome as {
      runtime?: { sendMessage?: ReturnType<typeof vi.fn> };
    };
    const sendMessage = chromeLike.runtime?.sendMessage;
    expect(sendMessage).toBeTypeOf("function");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.plugin.ui_hook.run",
        pluginId: "plugin.test.ui.mem",
        hook: "ui.notice.before_show",
        sessionId: "plugin-studio"
      })
    );
  });
});
